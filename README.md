# roku-mqtt

TLDR: NodeJS Gateway between Roku devices and MQTT

This application polls Roku devices using Roku's ECP API to poll Roku devices on the network and publishes status changes to MQTT. In addition, it can also also use the API to simulate remote control keypresses.
* Monitors power status and publishes state changes. For legacy Roku devices, that's just PowerOn and PowerOff. For Roku TV's and StreamBars, it'll also detect when the device is suspended.
* Publishes current application to MQTT, or "Home" if not in an application. It'll also publish when a screensaver engages.
* Injects remote control buttons and text
* Detects Roku's using uPnP and/or network scan. Addiional Roku's can be added after start up using MQTT
* Intended to run continuously as a systemd service, with systemd automatically restarting after a failure

## MQTT Messages

Topics can be configured using config.json - see below. Roku devices in MQTT topics are identified using a device slug

### Output Topics

* Birth and will - Published on startup and shutdown - Suggested topic: home/roku/roku-mqtt/status. Payload will be "start" on startup and "stop" on shutdown
* Roku power state - Suggested topic: home/roku/{device_slug}/state - Payloads is one off: "on", "off", "ready", "suspend" and "gone". Note there may be a delay before detecting the "off" state. The "gone" state will be used in the unlikely event that a non-Roku device appears on an IP address previously used by a Roku.
* Roku Application - Suggested topic: home_mlb/roku/{device_slug}/app - Text name of application currently in use. If Roku is not in an app, payload will be "Home". If a screensaver has been activated, payload will be "ScreenSaver:" followed by the name of the screen saver.

### Input Topics
* Change application - Suggested topic: home/roku/{device_slug}/set/app. Payload is application name either as is (example: "Radio Paradise"), or in slug form (example: radio_paradise). In either case, the application name is case insensitive.
* Keypress - Suggested topic: home/roku/{device_slug}/set/keypress. Simple payload is key to simulate. Alternatively, payload may be a space seperated list of keys, or the keywords "wait" or "delay" followed by delay time in seconds surrounded by parenthesis. Example delay(1). Delay time may be fractional. Other keys may also be followed by a repeat count, also in parenthesis.
Example: "home down(2) left(1) delay(2)"
* New Roku device - Topic is configurable in config.json. Payload is either just the IP address of the new device or, if the payload is a JSON message, an attribute in that message.


## References
* Slug - https://en.wikipedia.org/wiki/Clean_URL#Slug
* Roku ECP - https://developer.roku.com/docs/developer-program/debugging/external-control-api.md
