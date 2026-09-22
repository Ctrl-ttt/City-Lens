// Thin, one-command-per-process adapter to Insta360's official Windows SDK.
// No video capture or relative motor motion: the browser owns the video stream.
#include <windows.h>
#include <uvc_camera.h>
#include <algorithm>
#include <cctype>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace {
std::string quote(const std::string& value) {
    std::ostringstream out;
    out << '"';
    const char* hex = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << "\\u00" << hex[c >> 4] << hex[c & 15];
        else out << c;
    }
    out << '"';
    return out.str();
}
std::string id(const UVCCameraInfo& info) {
    // Device path, not enumeration order: unplugging must never redirect a command.
    const char* hex = "0123456789abcdef";
    std::string result;
    for (unsigned char c : info.display_name) {
        result += hex[c >> 4]; result += hex[c & 15];
    }
    return result;
}
bool is_link2(const UVCCameraInfo& info) {
    std::string name;
    for (unsigned char c : info.friendly_name)
        if (std::isalnum(c)) name += static_cast<char>(std::tolower(c));
    return name == "insta360link2" || name == "link2";
}
void require(bool ok, const char* code = "sdk_failed") {
    if (!ok) throw std::runtime_error(code);
}
long number(const char* text, long low, long high) {
    size_t used = 0;
    long value = std::stol(text, &used);
    require(used == std::string(text).size() && value >= low && value <= high, "invalid_input");
    return value;
}
std::string status(uvc::UVCCameraController& camera, uvc::UVCCameraExtendController& ext) {
    int32_t pan = 0, tilt = 0;
    bool autofocus = false;
    CameraControlInfo zoom{};
    long current_zoom = 0;
    // Link 2 hardware uses (tilt, pan), despite the SDK parameter names.
    bool ptz_ok = ext.GetPanTiltAbsoluteValue(tilt, pan);
    bool zoom_ok = camera.GetZoomAbsoluteRange(zoom) && camera.GetZoomAbsolute(current_zoom)
        && zoom.max >= zoom.min && zoom.step > 0;
    bool focus_ok = camera.GetAutoFocusStatus(autofocus);
    std::ostringstream out;
    out << "{\"ptz\":";
    if (ptz_ok) out << "{\"pan\":" << pan / 3600.0 << ",\"tilt\":" << tilt / 3600.0 << '}';
    else out << "null";
    out << ",\"zoom\":";
    if (zoom_ok) out << "{\"min\":" << zoom.min << ",\"max\":" << zoom.max
        << ",\"step\":" << zoom.step << ",\"value\":" << current_zoom << '}';
    else out << "null";
    out << ",\"autofocus\":" << (focus_ok ? (autofocus ? "true" : "false") : "null") << '}';
    return out.str();
}
std::string execute(int argc, char** argv) {
    require(argc >= 2, "invalid_input");
    std::string command = argv[1];
    require(command == "list" || command == "status" || command == "ptz" || command == "zoom"
        || command == "autofocus", "invalid_input");
    std::vector<UVCCameraInfo> all;
    uvc::GetUVCCameraList(all);
    all.erase(std::remove_if(all.begin(), all.end(), [](const auto& c) {
        return !is_link2(c) || c.display_name.empty();
    }), all.end());
    if (command == "list") {
        require(argc == 2, "invalid_input");
        std::string output = "{\"devices\":[";
        bool first = true;
        for (const auto& c : all) {
            if (!first) output += ',';
            first = false;
            output += "{\"id\":" + quote(id(c)) + ",\"name\":" + quote(c.friendly_name) + '}';
        }
        return output + "]}";
    }
    require(argc >= 3, "invalid_input");
    auto selected = std::find_if(all.begin(), all.end(), [&](const auto& c) { return id(c) == argv[2]; });
    require(selected != all.end(), "device_not_found");
    uvc::UVCCameraController camera(*selected);
    uvc::UVCCameraExtendController ext(*selected);
    if (command == "status") {
        require(argc == 3, "invalid_input");
        return status(camera, ext);
    }
    if (command == "ptz") {
        require(argc == 5, "invalid_input");
        long pan = number(argv[3], -145, 145), tilt = number(argv[4], -45, 90);
        // Link 2 hardware uses (tilt, pan) in 3600 units/degree.
        require(ext.SetPanTiltAbsolute(static_cast<int32_t>(tilt * 3600), static_cast<int32_t>(pan * 3600)));
    } else if (command == "zoom") {
        require(argc == 4, "invalid_input");
        CameraControlInfo range{};
        require(camera.GetZoomAbsoluteRange(range) && range.step > 0);
        long zoom = number(argv[3], range.min, range.max);
        require((zoom - range.min) % range.step == 0, "invalid_input");
        require(camera.SetZoomAbsolute(zoom));
    } else if (command == "autofocus") {
        require(argc == 4, "invalid_input");
        require(camera.EnableAutoFocus(number(argv[3], 0, 1) == 1));
    }
    // Acceptance does not imply that a moving gimbal has reached the target yet.
    return "{\"accepted\":true}";
}
}
int main(int argc, char** argv) {
    HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    std::string output;
    int code = 0;
    try {
        require(SUCCEEDED(com) || com == RPC_E_CHANGED_MODE, "sdk_failed");
        output = execute(argc, argv);
    } catch (const std::exception& error) {
        std::string reason = error.what();
        if (reason != "sdk_failed" && reason != "device_not_found" && reason != "invalid_input") reason = "sdk_failed";
        output = "{\"error\":" + quote(reason) + '}'; code = 1;
    }
    if (SUCCEEDED(com)) CoUninitialize();
    // SDK diagnostics may also use stdout; only this framed line is the protocol.
    std::cout << "\nCITYLENS_JSON=" << output << std::endl;
    return code;
}
