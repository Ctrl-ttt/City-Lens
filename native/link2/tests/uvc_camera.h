#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct UVCCameraInfo { std::string display_name, friendly_name; };
struct CameraControlInfo { long min = 100, max = 400, step = 1; };

namespace uvc {
inline int32_t hardware_tilt = -12 * 3600;
inline int32_t hardware_pan = 34 * 3600;
inline void GetUVCCameraList(std::vector<UVCCameraInfo>& devices) {
    devices.push_back({"test", "Insta360 Link 2"});
}
class UVCCameraController {
public:
    explicit UVCCameraController(const UVCCameraInfo&) {}
    bool GetZoomAbsoluteRange(CameraControlInfo&) { return true; }
    bool GetZoomAbsolute(long& value) { value = 100; return true; }
    bool GetAutoFocusStatus(bool& value) { value = true; return true; }
    bool SetZoomAbsolute(long) { return true; }
    bool EnableAutoFocus(bool) { return true; }
};
class UVCCameraExtendController {
public:
    explicit UVCCameraExtendController(const UVCCameraInfo&) {}
    bool GetPanTiltAbsoluteValue(int32_t& first, int32_t& second) {
        first = hardware_tilt; second = hardware_pan; return true;
    }
    bool SetPanTiltAbsolute(int32_t first, int32_t second) {
        hardware_tilt = first; hardware_pan = second; return true;
    }
};
}
