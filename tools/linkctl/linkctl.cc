// CityLens · Insta360 Link SDK 桥接命令行工具
//
// 为什么需要这一层
// ----------------
// Link SDK 是 C++ 类库（UVCCamera.dll + UVCCamera.lib），接口签名里含
// std::string / std::vector / std::map / std::function，Python 无法用 ctypes 直接映射。
// 因此提供一个「一次调用一个命令」的薄包装：
//
//     linkctl.exe <command> [args...]
//
// 每个命令要么执行完退出，要么在打开相机的生命周期内读取一次状态后退出。
// 之所以选择「子进程」而不是把 DLL 直接嵌进后端进程，是为了故障隔离：
// USB 控制传输在设备被独占或拔线时可能长时间阻塞，子进程可以被超时杀掉，
// 而内嵌 DLL 的阻塞会把整个服务拖死 —— 现场演示时这一点很关键。
//
// 输出约定
// --------
// SDK 内部会向 stdout 打日志（llog），无法关闭（未提供配置头文件），
// 所以结果行用 "#JSON#" 前缀标记，调用方只需取最后一个以 "#JSON#" 开头的行。
//
// 退出码：0 成功，1 参数错误，2 未找到相机，3 命令执行失败。

#include <uvc_camera.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr const char* kMarker = "#JSON#";
constexpr uint16_t kInsta360Vid = 0x2e1a;  // 影石 USB 厂商 ID

// 编译期护栏
// ----------
// uvc_common.h 用 `#ifdef WIN32` 在两种 UVCCameraInfo 布局之间切换（Windows 布局 72 字节，
// 非 Windows 布局 80 字节）。如果编译时漏了 /DWIN32，本文件会按 80 字节解析而 DLL 按 72 字节写入，
// 结果是 std::vector 的 size() 计算错位（1 个元素 72/80 == 0），相机枚举静默返回空列表。
// 这里用静态断言把这个隐蔽的运行时故障提前成编译错误。原因详见 tools/linkctl/build.ps1。
static_assert(sizeof(UVCCameraInfo) == 72,
              "UVCCameraInfo 布局与 SDK 预编译库不一致：编译时必须定义 WIN32 宏（见 build.ps1）");

// ---------------------------------------------------------------- 工具函数

std::string Esc(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (size_t i = 0; i < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                }
                else {
                    // UTF-8 多字节序列原样输出，JSON 本身允许 UTF-8
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

std::string Num(int64_t v) {
    std::ostringstream os;
    os << v;
    return os.str();
}

void Emit(const std::string& json) {
    std::cout << kMarker << json << std::endl;
}

void EmitOk(const std::string& body = std::string()) {
    Emit("{\"ok\":true" + (body.empty() ? std::string() : std::string(",") + body) + "}");
}

// 失败时也要给出结构化结果，调用方无需依赖退出码猜原因
int Fail(const std::string& code, const std::string& message, int exit_code = 3) {
    Emit("{\"ok\":false,\"error\":{\"code\":\"" + Esc(code) + "\",\"message\":\"" + Esc(message) + "\"}}");
    std::cout.flush();
    return exit_code;
}

// ---------------------------------------------------------------- 枚举名称表

const char* ExtendFuncName(int i) {
    static const char* kNames[] = {
        "AiZoom",                 // 0  智能变焦
        "AF",                     // 1  自动对焦
        "HDR",                    // 2  高动态范围
        "Mirror",                 // 3  水平镜像
        "Ai",                     // 4  AI 算法（手势总开关）
        "VScreen",                // 5  竖屏
        "EnableStartupSetting",   // 6  保存使能
        "EnableSingleTapTracking",// 7  掰轴跟踪
        "EnableTracking",         // 8  触摸跟踪
        "SmartAdjustment",        // 9  智能调整
        "ForcedVertical",         // 10 强制竖拍
        "ExtremePrivacy",         // 11 极致隐私
        "MirrorVertically",       // 12 垂直镜像
        "LowResolution",          // 13 低分辨率
        "TrackForbiddenArea",     // 14 追踪禁区
        "AudioSystemVolume",      // 15 音频系统音量
    };
    const int n = static_cast<int>(sizeof(kNames) / sizeof(kNames[0]));
    return (i >= 0 && i < n) ? kNames[i] : "Unknown";
}

const char* VideoModeName(int m) {
    switch (m) {
        case 0:  return "Normal";
        case 1:  return "AutoComposition";
        case 4:  return "Whiteboard";
        case 5:  return "Craneshot";
        case 6:  return "DeskView";
        case 7:  return "AutoFraming";
        case 8:  return "SmartWhiteboard";
        case 10: return "SmartWhiteboardQuery";
        default: return "Unknown";
    }
}

const char* CompositionStyleName(int s) {
    switch (s) {
        case 0:  return "None";
        case 1:  return "OnlyHead";
        case 2:  return "HalfBody";
        case 3:  return "FullBody";
        default: return "Unknown";
    }
}

const char* TrackSpeedName(int s) {
    switch (s) {
        case 0:  return "Fast";
        case 1:  return "Normal";
        case 2:  return "Slow";
        default: return "Unknown";
    }
}

const char* VideoModeStatusName(int s) {
    switch (s) {
        case 0x00: return "Normal";
        case 0x01: return "Detecting";
        case 0x02: return "Working";
        case 0x03: return "LostObj";
        case 0x10: return "EnterDeskView";
        case 0x11: return "DeskViewFailed";
        default:   return "Unknown";
    }
}

// ---------------------------------------------------------------- 会话

// UVCCameraController / UVCCameraExtendController 没有默认构造函数，
// 因此用指针延迟构造。
struct Session {
    UVCCameraInfo                  info;
    uvc::UVCCameraController*      cam;
    uvc::UVCCameraExtendController* ext;

    explicit Session(const UVCCameraInfo& i)
        : info(i), cam(new uvc::UVCCameraController(i)), ext(new uvc::UVCCameraExtendController(i)) {}

    ~Session() {
        delete cam;
        delete ext;
    }

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;
};

std::string CameraJson(const UVCCameraInfo& info, bool opened) {
    std::ostringstream os;
    os << "\"friendly_name\":\"" << Esc(info.friendly_name) << "\""
       << ",\"display_name\":\"" << Esc(info.display_name) << "\""
       << ",\"vendor_id\":" << info.vendor_id
       << ",\"product_id\":" << info.product_id
       << ",\"video_device_index\":" << info.video_device_index
       << ",\"opened\":" << (opened ? "true" : "false");
    return os.str();
}

// 选择相机：优先精确 vid+pid，其次只按 vid（影石设备），最后退化为第一个
//
// 注意 SDK 的命名空间分布：只有 GetUVCCameraList 与三个 Controller 类在 namespace uvc 内，
// 其余结构体与枚举都在全局作用域（SDK 自带的示例靠 `using namespace uvc;` 蒙过去了），
// 所以下列类型名一律不加 uvc:: 前缀。
bool PickCamera(uint16_t vid, uint16_t pid, UVCCameraInfo& out, std::string& err) {
    std::vector<UVCCameraInfo> list;
    uvc::GetUVCCameraList(list);
    if (list.empty()) {
        err = "未发现任何 UVC 相机";
        return false;
    }
    for (size_t i = 0; i < list.size(); ++i) {
        if (list[i].vendor_id == vid && list[i].product_id == pid) {
            out = list[i];
            return true;
        }
    }
    for (size_t i = 0; i < list.size(); ++i) {
        if (list[i].vendor_id == vid) {
            out = list[i];
            return true;
        }
    }
    out = list[0];
    return true;
}

// 解析形如 0x4c04 / 19460 的数值
bool ParseU16(const std::string& s, uint16_t& out) {
    if (s.empty()) return false;
    char* end = nullptr;
    const long v = std::strtol(s.c_str(), &end, 0);
    if (end == s.c_str() || v < 0 || v > 0xFFFF) return false;
    out = static_cast<uint16_t>(v);
    return true;
}

std::string ArgOr(const std::vector<std::string>& a, size_t i, const std::string& def) {
    return i < a.size() ? a[i] : def;
}

int ArgInt(const std::vector<std::string>& a, size_t i, int def) {
    if (i >= a.size()) return def;
    return std::atoi(a[i].c_str());
}

// ---------------------------------------------------------------- 复合查询

// health 把「设备信息 + 扩展开关 + 视频模式」合成一次调用，
// 避免前端每次刷新都启动三个子进程。
std::string BuildHealth(Session& s) {
    std::ostringstream os;
    os << "\"camera\":{" << CameraJson(s.info, true) << "}";

    std::string type;
    if (s.ext->GetCameraType(type)) {
        os << ",\"type\":\"" << Esc(type) << "\"";
    }
    os << ",\"pid\":" << s.ext->GetPID();

    DeviceStatus st;
    if (s.ext->GetDeviceStatus(st)) {
        os << ",\"status\":{\"cpu_temp\":" << static_cast<int>(st.cpu_temperature)
           << ",\"sensor_temp\":" << static_cast<int>(st.sensor_temperature)
           << ",\"stream_open\":" << (st.video_stream_is_opend ? "true" : "false")
           << ",\"upgrading\":" << (st.fireware_is_upgrading ? "true" : "false") << "}";
    }

    uint32_t w = 0, h = 0;
    uint16_t fps = 0;
    if (s.ext->GetCameraPlayRes(w, h, fps)) {
        os << ",\"play_res\":{\"width\":" << w << ",\"height\":" << h << ",\"framerate\":" << fps << "}";
    }

    VideoMode mode = VideoMode::Normal;
    VideoModeAuxiliaryData aux;
    if (s.ext->GetVideoMode(mode, aux)) {
        const int m = static_cast<int>(mode);
        os << ",\"video_mode\":{\"value\":" << m << ",\"name\":\"" << VideoModeName(m)
           << "\",\"status\":" << static_cast<int>(aux.video_mode_status)
           << ",\"status_name\":\"" << VideoModeStatusName(static_cast<int>(aux.video_mode_status)) << "\"";
        os << ",\"default_track_mode\":" << aux.default_track_mode
           << ",\"privacy_mode\":" << aux.privacy_mode
           << ",\"enable_privacy\":" << (aux.enable_privacy ? "true" : "false")
           << ",\"horizontal_correct_exceed\":" << (aux.horizontal_correct_exceed ? "true" : "false")
           << "}";
    }

    CompositionStyle style = static_cast<CompositionStyle>(0);
    if (s.ext->GetCompositionStyle(style)) {
        const int v = static_cast<int>(style);
        os << ",\"composition_style\":{\"value\":" << v << ",\"name\":\"" << CompositionStyleName(v) << "\"}";
    }

    TrackSpeed speed = TrackSpeed::Normal;
    if (s.ext->GetTrackSpeed(speed)) {
        const int v = static_cast<int>(speed);
        os << ",\"track_speed\":{\"value\":" << v << ",\"name\":\"" << TrackSpeedName(v) << "\"}";
    }

    uint16_t zoom = 0;
    if (s.ext->GetRealZoomValue(zoom)) {
        os << ",\"real_zoom\":" << zoom;
    }

    std::map<ExtendFuction, bool> flags;
    if (s.ext->GetExtendFuncStatus(flags)) {
        os << ",\"extend\":{";
        bool first = true;
        for (std::map<ExtendFuction, bool>::const_iterator it = flags.begin(); it != flags.end(); ++it) {
            if (!first) os << ",";
            first = false;
            const int idx = static_cast<int>(it->first);
            os << "\"" << idx << "\":{\"name\":\"" << ExtendFuncName(idx)
               << "\",\"enabled\":" << (it->second ? "true" : "false") << "}";
        }
        os << "}";
    }
    return os.str();
}

// ---------------------------------------------------------------- 命令分发

void PrintUsage() {
    std::cout << "linkctl - Insta360 Link SDK 桥接工具\n"
                 "\n用法: linkctl.exe <command> [args...]\n"
                 "\n相机与状态\n"
                 "  list                          列出全部 UVC 相机\n"
                 "  info                          设备信息/温度/播放分辨率\n"
                 "  health                        复合查询: 信息+模式+扩展开关\n"
                 "  media-formats                 支持的媒体格式\n"
                 "\n构图与追踪\n"
                 "  video-mode                    当前视频模式\n"
                 "  set-video-mode <mode>         0 正常/1 自动构图/4 白板/5 俯拍/6 DeskView/7 多人构图/8 智能白板\n"
                 "  normal-mode                   切回正常模式(会重启相机)\n"
                 "  track-objs                    当前追踪目标(人头框, 归一化坐标)\n"
                 "  composition-style             当前构图风格\n"
                 "  set-composition-style <n>     1 人头像/2 半身/3 全身\n"
                 "  track-speed                   当前追踪速度\n"
                 "  set-track-speed <n>           0 快/1 正常/2 慢\n"
                 "  default-track-mode            默认追踪模式\n"
                 "  set-default-track-mode <n>    0 单人/1 多人\n"
                 "\n扩展功能开关\n"
                 "  extend-status                 全部扩展功能开关状态\n"
                 "  set-extend <func> <0|1>       0 智能变焦/1 自动对焦/2 HDR/3 水平镜像/4 AI算法\n"
                 "                                5 竖屏/7 掰轴跟踪/8 触摸跟踪/9 智能调整/13 低分辨率/14 追踪禁区\n"
                 "\n云台\n"
                 "  ptz                           云台绝对角度(1/360 度)\n"
                 "  ptz-range                     pan/tilt 范围\n"
                 "  set-ptz <pan> <tilt>          设置绝对角度\n"
                 "  ptz-rel <pv> <ps> <tv> <ts>   相对移动(0 停/1 顺时针/255 逆时针, 速度 1-10)\n"
                 "  ptz-stop                      停止云台\n"
                 "\n画质\n"
                 "  zoom                          实时变焦值\n"
                 "  exposure-comp                 曝光补偿(EV)\n"
                 "  set-exposure-comp <ev>        设置曝光补偿\n"
                 "  iso                           当前 ISO\n"
                 "  set-iso <value>               设置 ISO\n"
                 "  low-resolution <0|1>          低分辨率开关\n"
                 "  vertical-screen <0|1>         竖屏开关\n"
                 "\n全局参数(可用 --vid/--pid 指定相机, 默认按影石 VID 0x2e1a 选取)\n";
}

}  // namespace

int main(int argc, char* argv[]) {
    std::vector<std::string> args;
    uint16_t vid = kInsta360Vid;
    uint16_t pid = 0;
    bool pid_set = false;

    // 先抽出全局参数，其余作为位置参数
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--vid" && i + 1 < argc) {
            ParseU16(argv[++i], vid);
        }
        else if (a == "--pid" && i + 1 < argc) {
            pid_set = ParseU16(argv[++i], pid);
        }
        else if (a == "-h" || a == "--help") {
            PrintUsage();
            return 0;
        }
        else {
            args.push_back(a);
        }
    }

    if (args.empty()) {
        PrintUsage();
        return 1;
    }

    const std::string cmd = args[0];

    // list 不需要打开相机
    if (cmd == "list") {
        std::vector<UVCCameraInfo> list;
        uvc::GetUVCCameraList(list);
        std::ostringstream os;
        os << "\"count\":" << list.size() << ",\"cameras\":[";
        for (size_t i = 0; i < list.size(); ++i) {
            if (i) os << ",";
            os << "{" << CameraJson(list[i], false) << "}";
        }
        os << "]";
        EmitOk(os.str());
        return 0;
    }

    if (!pid_set) {
        // 未指定 PID 时按「任意影石设备」选取
        pid = 0;
    }

    UVCCameraInfo info;
    std::string pick_err;
    if (!PickCamera(vid, pid, info, pick_err)) {
        return Fail("camera_not_found", pick_err, 2);
    }
    // pid 未指定时，PickCamera 取到哪台就以哪台为准
    Session session(info);

    if (cmd == "info") {
        std::ostringstream os;
        os << "\"camera\":{" << CameraJson(info, true) << "}";
        std::string type;
        if (session.ext->GetCameraType(type)) os << ",\"type\":\"" << Esc(type) << "\"";
        os << ",\"pid\":" << session.ext->GetPID();

        DeviceInfo di;
        if (session.ext->GetDeviceInfo(di)) {
            os << ",\"device\":{\"uuid\":\"" << Esc(di.uuid) << "\""
               << ",\"sensorId\":\"" << Esc(di.sensorId) << "\""
               << ",\"hostFirmwareVer\":\"" << Esc(di.hostFirmwareVer) << "\""
               << ",\"hostHardwareVer\":" << di.hostHardwareVer
               << ",\"ptzFirmwareVer\":" << di.ptzFirmwareVer
               << ",\"ptzHardwareVer\":" << static_cast<int>(di.ptzHardwareVer)
               << ",\"deviceType\":" << static_cast<int>(di.deviceType)
               << ",\"codecIsLegal\":" << (di.codecIsLegal ? "true" : "false") << "}";
        }
        std::string sn;
        if (session.ext->GetSerialNumber(sn)) os << ",\"serial_number\":\"" << Esc(sn) << "\"";

        DeviceStatus st;
        if (session.ext->GetDeviceStatus(st)) {
            os << ",\"status\":{\"cpu_temp\":" << static_cast<int>(st.cpu_temperature)
               << ",\"sensor_temp\":" << static_cast<int>(st.sensor_temperature)
               << ",\"stream_open\":" << (st.video_stream_is_opend ? "true" : "false")
               << ",\"upgrading\":" << (st.fireware_is_upgrading ? "true" : "false") << "}";
        }
        uint32_t w = 0, h = 0;
        uint16_t fps = 0;
        if (session.ext->GetCameraPlayRes(w, h, fps)) {
            os << ",\"play_res\":{\"width\":" << w << ",\"height\":" << h << ",\"framerate\":" << fps << "}";
        }
        PTZVerInfo ptz;
        if (session.ext->GetPTZVersionInfo(ptz)) {
            os << ",\"ptz_version\":{\"app_version\":" << ptz.app_version
               << ",\"hw_version\":" << static_cast<int>(ptz.hw_version)
               << ",\"imu_exist\":" << static_cast<int>(ptz.imu_exist)
               << ",\"touch_key\":" << static_cast<int>(ptz.touch_key) << "}";
        }
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "health") {
        EmitOk(BuildHealth(session));
        return 0;
    }

    if (cmd == "media-formats") {
        std::vector<UVCMediaFormat> formats;
        if (!session.cam->GetMediaFormatList(formats)) {
            return Fail("sdk_call_failed", "GetMediaFormatList 失败");
        }
        std::ostringstream os;
        os << "\"count\":" << formats.size() << ",\"formats\":[";
        for (size_t i = 0; i < formats.size(); ++i) {
            if (i) os << ",";
            os << "{\"width\":" << formats[i].width << ",\"height\":" << formats[i].height
               << ",\"framerate\":" << formats[i].framerate << "}";
        }
        os << "]";
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "video-mode") {
        VideoMode mode = VideoMode::Normal;
        VideoModeAuxiliaryData aux;
        if (!session.ext->GetVideoMode(mode, aux)) return Fail("sdk_call_failed", "GetVideoMode 失败");
        const int m = static_cast<int>(mode);
        EmitOk("\"video_mode\":{\"value\":" + Num(m) + ",\"name\":\"" + VideoModeName(m) +
               "\",\"status\":" + Num(static_cast<int>(aux.video_mode_status)) +
               ",\"status_name\":\"" + VideoModeStatusName(static_cast<int>(aux.video_mode_status)) + "\"}");
        return 0;
    }

    if (cmd == "set-video-mode") {
        const int m = ArgInt(args, 1, 0);
        VideoModeAuxiliaryData aux;
        if (!session.ext->SetVideoMode(static_cast<VideoMode>(m), aux)) {
            return Fail("sdk_call_failed", "SetVideoMode 失败，模式 " + Num(m));
        }
        EmitOk("\"video_mode\":{\"value\":" + Num(m) + ",\"name\":\"" + VideoModeName(m) + "\"}");
        return 0;
    }

    if (cmd == "normal-mode") {
        // SwitchNormalMode 会重启相机，浏览器需要重新取流
        if (!session.ext->SwitchNormalMode()) return Fail("sdk_call_failed", "SwitchNormalMode 失败");
        EmitOk("\"video_mode\":{\"value\":0,\"name\":\"Normal\"},\"note\":\"相机已重启，前端需重新取流\"");
        return 0;
    }

    if (cmd == "track-objs") {
        std::vector<UVCRect> objs;
        if (!session.ext->GetNewTrackObjLists(objs)) return Fail("sdk_call_failed", "GetNewTrackObjLists 失败");
        std::ostringstream os;
        os << "\"count\":" << objs.size() << ",\"objects\":[";
        for (size_t i = 0; i < objs.size(); ++i) {
            if (i) os << ",";
            os << "{\"x\":" << objs[i].point.x << ",\"y\":" << objs[i].point.y
               << ",\"w\":" << objs[i].width << ",\"h\":" << objs[i].height << "}";
        }
        os << "]";
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "composition-style") {
        CompositionStyle s = static_cast<CompositionStyle>(0);
        if (!session.ext->GetCompositionStyle(s)) return Fail("sdk_call_failed", "GetCompositionStyle 失败");
        const int v = static_cast<int>(s);
        EmitOk("\"composition_style\":{\"value\":" + Num(v) + ",\"name\":\"" + CompositionStyleName(v) + "\"}");
        return 0;
    }

    if (cmd == "set-composition-style") {
        const int v = ArgInt(args, 1, 1);
        if (!session.ext->SetCompositionStyle(static_cast<CompositionStyle>(v))) {
            return Fail("sdk_call_failed", "SetCompositionStyle 失败");
        }
        EmitOk("\"composition_style\":{\"value\":" + Num(v) + ",\"name\":\"" + CompositionStyleName(v) + "\"}");
        return 0;
    }

    if (cmd == "track-speed") {
        TrackSpeed s = TrackSpeed::Normal;
        if (!session.ext->GetTrackSpeed(s)) return Fail("sdk_call_failed", "GetTrackSpeed 失败");
        const int v = static_cast<int>(s);
        EmitOk("\"track_speed\":{\"value\":" + Num(v) + ",\"name\":\"" + TrackSpeedName(v) + "\"}");
        return 0;
    }

    if (cmd == "set-track-speed") {
        const int v = ArgInt(args, 1, 1);
        if (!session.ext->SetTrackSpeed(static_cast<TrackSpeed>(v))) {
            return Fail("sdk_call_failed", "SetTrackSpeed 失败");
        }
        EmitOk("\"track_speed\":{\"value\":" + Num(v) + ",\"name\":\"" + TrackSpeedName(v) + "\"}");
        return 0;
    }

    if (cmd == "default-track-mode" || cmd == "set-default-track-mode") {
        if (cmd == "default-track-mode") {
            int m = 0;
            if (!session.ext->GetDefaultTrackMode(m)) return Fail("sdk_call_failed", "GetDefaultTrackMode 失败");
            EmitOk("\"default_track_mode\":" + Num(m));
            return 0;
        }
        const int m = ArgInt(args, 1, 0);
        if (!session.ext->SetDefaultTrackMode(m)) return Fail("sdk_call_failed", "SetDefaultTrackMode 失败");
        EmitOk("\"default_track_mode\":" + Num(m));
        return 0;
    }

    if (cmd == "extend-status") {
        std::map<ExtendFuction, bool> flags;
        if (!session.ext->GetExtendFuncStatus(flags)) return Fail("sdk_call_failed", "GetExtendFuncStatus 失败");
        std::ostringstream os;
        os << "\"extend\":{";
        bool first = true;
        for (std::map<ExtendFuction, bool>::const_iterator it = flags.begin(); it != flags.end(); ++it) {
            if (!first) os << ",";
            first = false;
            const int idx = static_cast<int>(it->first);
            os << "\"" << idx << "\":{\"name\":\"" << ExtendFuncName(idx)
               << "\",\"enabled\":" << (it->second ? "true" : "false") << "}";
        }
        os << "}";
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "set-extend") {
        const int f = ArgInt(args, 1, -1);
        const int en = ArgInt(args, 2, -1);
        if (f < 0 || f > 15) return Fail("bad_argument", "func 取值应为 0..15", 1);
        if (en != 0 && en != 1) return Fail("bad_argument", "enable 取值应为 0 或 1", 1);
        if (!session.ext->EnableExtendFuncWork(static_cast<ExtendFuction>(f), en != 0)) {
            return Fail("sdk_call_failed", std::string("EnableExtendFuncWork 失败: ") + ExtendFuncName(f));
        }
        EmitOk(std::string("\"func\":{\"value\":") + Num(f) + ",\"name\":\"" + ExtendFuncName(f) +
               "\",\"enabled\":" + (en ? "true" : "false") + "}");
        return 0;
    }

    if (cmd == "ptz") {
        int32_t pan = 0, tilt = 0;
        if (!session.ext->GetPanTiltAbsoluteValue(pan, tilt)) return Fail("sdk_call_failed", "GetPanTiltAbsoluteValue 失败");
        std::ostringstream os;
        // 单位是 1/360 度，换算成度便于阅读
        os << "\"ptz\":{\"pan\":" << pan << ",\"tilt\":" << tilt
           << ",\"pan_deg\":" << (pan / 360.0) << ",\"tilt_deg\":" << (tilt / 360.0) << "}";
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "ptz-range") {
        CameraControlInfo pan{};
        CameraControlInfo tilt{};
        if (!session.cam->GetPanTiltAbsoluteRange(pan, tilt)) {
            return Fail("sdk_call_failed", "GetPanTiltAbsoluteRange 失败");
        }
        std::ostringstream os;
        os << "\"pan\":{\"min\":" << pan.min << ",\"max\":" << pan.max << ",\"step\":" << pan.step
           << ",\"cur\":" << pan.cur << "}"
           << ",\"tilt\":{\"min\":" << tilt.min << ",\"max\":" << tilt.max << ",\"step\":" << tilt.step
           << ",\"cur\":" << tilt.cur << "}";
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "set-ptz") {
        const int32_t pan = static_cast<int32_t>(ArgInt(args, 1, 0));
        const int32_t tilt = static_cast<int32_t>(ArgInt(args, 2, 0));
        if (!session.ext->SetPanTiltAbsolute(pan, tilt)) return Fail("sdk_call_failed", "SetPanTiltAbsolute 失败");
        EmitOk("\"ptz\":{\"pan\":" + Num(pan) + ",\"tilt\":" + Num(tilt) + "}");
        return 0;
    }

    if (cmd == "ptz-rel" || cmd == "ptz-stop") {
        CameraControlRelativeInfo pan{}, tilt{};
        if (cmd == "ptz-stop") {
            pan.speed = 0;
            pan.value = CameraControlRelativeValue::Stop;
            tilt.speed = 0;
            tilt.value = CameraControlRelativeValue::Stop;
        }
        else {
            pan.value = static_cast<CameraControlRelativeValue>(ArgInt(args, 1, 0));
            pan.speed = ArgInt(args, 2, 1);
            tilt.value = static_cast<CameraControlRelativeValue>(ArgInt(args, 3, 0));
            tilt.speed = ArgInt(args, 4, 1);
        }
        if (!session.ext->SetPanTiltRelative(pan, tilt)) return Fail("sdk_call_failed", "SetPanTiltRelative 失败");
        EmitOk();
        return 0;
    }

    if (cmd == "zoom") {
        uint16_t zoom = 0;
        if (!session.ext->GetRealZoomValue(zoom)) return Fail("sdk_call_failed", "GetRealZoomValue 失败");
        EmitOk("\"real_zoom\":" + Num(zoom));
        return 0;
    }

    if (cmd == "exposure-comp") {
        float v = 0;
        if (!session.ext->GetExposureCompensation(v)) return Fail("sdk_call_failed", "GetExposureCompensation 失败");
        std::ostringstream os;
        os << "\"exposure_compensation\":" << v;
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "set-exposure-comp") {
        const double dv = (args.size() > 1) ? std::atof(args[1].c_str()) : 0.0;
        if (!session.ext->SetExposureCompensation(static_cast<float>(dv))) {
            return Fail("sdk_call_failed", "SetExposureCompensation 失败");
        }
        std::ostringstream os;
        os << "\"exposure_compensation\":" << dv;
        EmitOk(os.str());
        return 0;
    }

    if (cmd == "iso") {
        uint16_t v = 0;
        if (!session.ext->GetISOValue(v)) return Fail("sdk_call_failed", "GetISOValue 失败");
        EmitOk("\"iso\":" + Num(v));
        return 0;
    }

    if (cmd == "set-iso") {
        const int v = ArgInt(args, 1, 100);
        if (!session.ext->SetISOValue(static_cast<uint16_t>(v))) return Fail("sdk_call_failed", "SetISOValue 失败");
        EmitOk("\"iso\":" + Num(v));
        return 0;
    }

    if (cmd == "low-resolution") {
        if (args.size() < 2) {
            std::map<ExtendFuction, bool> flags;
            if (session.ext->GetExtendFuncStatus(flags)) {
                const bool en = flags[ExtendFuction::LowResolution];
                EmitOk(std::string("\"low_resolution\":") + (en ? "true" : "false"));
                return 0;
            }
            return Fail("sdk_call_failed", "GetExtendFuncStatus 失败");
        }
        const bool en = ArgInt(args, 1, 0) != 0;
        if (!session.ext->EnableLowResolution(en)) return Fail("sdk_call_failed", "EnableLowResolution 失败");
        EmitOk(std::string("\"low_resolution\":") + (en ? "true" : "false"));
        return 0;
    }

    if (cmd == "vertical-screen") {
        const bool en = ArgInt(args, 1, 0) != 0;
        if (!session.ext->EnableVerticalScreen(en)) return Fail("sdk_call_failed", "EnableVerticalScreen 失败");
        EmitOk(std::string("\"vertical_screen\":") + (en ? "true" : "false"));
        return 0;
    }

    return Fail("unknown_command", "未知命令: " + cmd, 1);
}
