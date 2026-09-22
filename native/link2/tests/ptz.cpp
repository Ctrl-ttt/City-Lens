#define main bridge_entrypoint
#include "../main.cpp"
#undef main

int main() {
    try {
        UVCCameraInfo device{"test", "Insta360 Link 2"};
        uvc::UVCCameraController camera(device);
        uvc::UVCCameraExtendController ext(device);
        require(status(camera, ext).find("\"ptz\":{\"pan\":34,\"tilt\":-12}") != std::string::npos,
                "SDK status axes must map to horizontal pan and vertical tilt");
        for (const auto& angles : {std::pair{20, -10}, std::pair{-145, 90}, std::pair{145, -45}}) {
            std::string command[] = {"bridge", "ptz", id(device), std::to_string(angles.first), std::to_string(angles.second)};
            char* arguments[] = {command[0].data(), command[1].data(), command[2].data(), command[3].data(), command[4].data()};
            require(execute(5, arguments) == "{\"accepted\":true}", "PTZ command must be accepted");
            require(uvc::hardware_pan == angles.first * 3600, "Horizontal input must control hardware pan");
            require(uvc::hardware_tilt == angles.second * 3600, "Vertical input must control hardware tilt");
            std::string expected = "\"ptz\":{\"pan\":" + command[3] + ",\"tilt\":" + command[4] + "}";
            require(status(camera, ext).find(expected) != std::string::npos, "PTZ status must round-trip the commanded axes");
        }
        std::cout << "PTZ read/write axis regression passed; no SDK or hardware used." << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
