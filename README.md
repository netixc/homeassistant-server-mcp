# Home Assistant MCP Server

A Model Context Protocol (MCP) server for interacting with Home Assistant. This server provides tools to control and monitor your Home Assistant devices through MCP-enabled applications.

## Features

### Core Device Control
- Get device states for any Home Assistant entity
- Control device states (on/off) for switches, lights, etc.
- Advanced light control with brightness, RGB colors, and color temperature
- List available entities with optional domain filtering

### Entertainment & Media Control
- Send remote control commands to TV/Android TV devices
- Launch apps by package name on smart devices
- Quick streaming app launcher (Plex, YouTube, Netflix, Prime Video, Disney+)

### Automation & Scripts
- Trigger Home Assistant automations
- Run Home Assistant scripts

## Installation

1. Clone this repository:
```bash
git clone https://github.com/netixc/homeassistant-server-mcp.git
cd homeassistant-server-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Configure the MCP server by adding the following to your MCP settings file (typically located at `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` for VSCode):

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": ["/path/to/homeassistant-mcp/homeassistant-server/build/index.js"],
      "env": {
        "HA_URL": "http://your-homeassistant-url:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

Replace `your-homeassistant-url` and `your-long-lived-access-token` with your Home Assistant instance URL and access token.

### Selective Tool Loading

You can optionally enable only specific tools by using the `--tools` parameter:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": [
        "/path/to/homeassistant-mcp/homeassistant-server/build/index.js",
        "--tools=get_state,toggle_entity,control_light,list_entities"
      ],
      "env": {
        "HA_URL": "http://your-homeassistant-url:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

Available tools:
- `get_state` - Get entity states
- `toggle_entity` - Toggle entities on/off
- `control_light` - Advanced light control
- `list_entities` - List available entities
- `trigger_automation` - Trigger automations
- `run_script` - Run scripts
- `activate_scene` - Activate scenes
- `list_scenes` - List available scenes
- `send_remote_command` - Send remote commands
- `launch_app` - Launch apps on devices
- `open_streaming_app` - Quick streaming app launcher
- `control_media_player` - Control media players
- `get_media_player_state` - Get media player state
- `send_notification` - Send notifications
- `list_notify_services` - List notification services
- `get_sensor_data` - Get sensor data
- `list_sensors` - List all sensors
- `call_service` - Call any HA service
- `list_services` - List available services
- `render_template` - Render templates
- `get_events` - Get recent events
- `fire_event` - Fire custom events
- `backup_management` - Manage backups
- `system_info` - Get system information
- `manage_todo_lists` - Manage to-do lists
- `manage_shopping_list` - Manage shopping list

If no `--tools` parameter is provided, all tools will be enabled.

## Usage

The server provides the following tools:

### Device Control Tools

#### Get Device State
Get the current state of any Home Assistant entity.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "get_state",
  arguments: {
    entity_id: "light.living_room"
  }
});
```

#### Toggle Entity
Turn any entity on or off.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "toggle_entity",
  arguments: {
    entity_id: "switch.bedroom",
    state: "on"  // or "off"
  }
});
```

#### Advanced Light Control
Control lights with brightness, color, and color temperature.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "control_light",
  arguments: {
    entity_id: "light.living_room",
    state: "on",
    brightness: 200,
    rgb_color: [255, 100, 50],
    color_temp: 300
  }
});
```

#### List Entities
List all available entities, optionally filtered by domain.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "list_entities",
  arguments: {
    domain: "light"  // optional, filters by domain
  }
});
```

### Entertainment & Remote Control Tools

#### Send Remote Command
Send remote control commands to TV/Android TV devices.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "send_remote_command",
  arguments: {
    entity_id: "remote.tv",
    command: "DPAD_UP"  // Navigation, volume, media controls, etc.
  }
});
```

#### Launch App
Launch specific apps on smart devices.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "launch_app",
  arguments: {
    entity_id: "remote.tv",
    activity: "com.plexapp.android"
  }
});
```

#### Quick Streaming Apps
One-click launch of popular streaming services.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "open_streaming_app",
  arguments: {
    entity_id: "remote.tv",
    app: "netflix"  // plex, youtube, netflix, prime, disney
  }
});
```

### Automation Tools

#### Trigger Automation
Run Home Assistant automations.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "trigger_automation",
  arguments: {
    automation_id: "automation.morning_routine"
  }
});
```

#### Run Script
Execute Home Assistant scripts.
```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "run_script",
  arguments: {
    script_id: "script.open_plex"
  }
});
```

## License

This project is licensed under the MIT License - see below for details:

```
MIT License

Copyright (c) 2024 homeassistant-mcp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Security

To securely use this server:

1. Always use HTTPS for your Home Assistant instance
2. Keep your access tokens secure and never commit them to version control
3. Regularly rotate your access tokens
4. Use environment variables for sensitive information
