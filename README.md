# Home Assistant MCP Server

A Model Context Protocol (MCP) server for interacting with Home Assistant. This server provides **8 optimized core tools** to control and monitor your Home Assistant devices through MCP-enabled applications, with minimal context usage for better LLM performance.

## Features

### Core Tools (8 Total)

**Discovery & State:**
- `get_state` - Get state and attributes of any entity
- `list_entities` - Discover entities with domain filtering
- `list_services` - Discover available services

**Control:**
- `call_service` - Universal service caller for all Home Assistant services (automations, scripts, scenes, media players, switches, notifications, climate, etc.)
- `control_light` - Advanced light control with brightness, RGB colors, and color temperature

**Advanced:**
- `render_template` - Jinja2 template rendering
- `manage_todo_lists` - Manage custom to-do lists
- `manage_shopping_list` - Manage shopping list

## Why Only 8 Tools?

This server has been optimized to reduce LLM context usage by 70%+. Instead of 26 separate tools, we use:
- **`call_service`** as a universal tool that can trigger automations, run scripts, activate scenes, control media players, send notifications, and more
- **Specialized tools** only for complex operations (lights with RGB/brightness, todo lists with due dates)

**Benefits:**
- ✅ **Faster responses** - Less context for LLM to process
- ✅ **Better accuracy** - Fewer tools = easier tool selection
- ✅ **Lower token costs** - ~1000 fewer tokens per request
- ✅ **Same functionality** - All features still available via `call_service`

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
      "args": ["/path/to/homeassistant-server-mcp/build/index.js"],
      "env": {
        "HA_URL": "http://your-homeassistant-url:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

Replace `your-homeassistant-url` and `your-long-lived-access-token` with your Home Assistant instance URL and access token.

### Tool Profiles

Use pre-configured profiles for common use cases:

```json
{
  "mcpServers": {
    "homeassistant": {
      "command": "node",
      "args": [
        "/path/to/homeassistant-server-mcp/build/index.js",
        "--profile=complete"
      ],
      "env": {
        "HA_URL": "http://your-homeassistant-url:8123",
        "HA_TOKEN": "your-long-lived-access-token"
      }
    }
  }
}
```

**Available Profiles:**

- **`minimal`** (3 tools) - Basic state reading and service calls
  - `get_state`, `call_service`, `list_entities`

- **`basic`** (5 tools) - Adds light control and service discovery
  - `get_state`, `call_service`, `list_entities`, `control_light`, `list_services`

- **`standard`** (7 tools) - Adds shopping list and templates
  - `get_state`, `call_service`, `list_entities`, `control_light`, `list_services`, `manage_shopping_list`, `render_template`

- **`complete`** (8 tools, default) - All core tools
  - All of the above + `manage_todo_lists`

**Custom Tool Selection:**

Or select specific tools manually:

```json
"args": [
  "/path/to/homeassistant-server-mcp/build/index.js",
  "--tools=get_state,call_service,control_light"
]
```

**Available Core Tools:**
1. `get_state` - Read entity states and attributes
2. `list_entities` - Discover entities by domain
3. `control_light` - Control lights with brightness/RGB/color temp
4. `call_service` - Universal service caller (automations, scripts, scenes, media, notifications, etc.)
5. `list_services` - Discover available services
6. `render_template` - Render Jinja2 templates
7. `manage_todo_lists` - Manage custom to-do lists
8. `manage_shopping_list` - Manage shopping list

## Usage Examples

### Reading State

```typescript
// Get any entity's state and attributes
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "get_state",
  arguments: {
    entity_id: "sensor.temperature"
  }
});

// List entities by domain
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "list_entities",
  arguments: {
    domain: "light"  // Returns all light entities
  }
});
```

### Controlling Devices

```typescript
// Advanced light control (brightness, RGB, color temp)
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "control_light",
  arguments: {
    entity_id: "light.living_room",
    state: "on",
    brightness: 200,
    rgb_color: [255, 100, 50]
  }
});

// Turn on any switch/device
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "homeassistant",
    service: "turn_on",
    target: { entity_id: "switch.bedroom" }
  }
});
```

### Automations & Scenes

```typescript
// Trigger automation
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "automation",
    service: "trigger",
    target: { entity_id: "automation.morning_routine" }
  }
});

// Run script
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "script",
    service: "turn_on",
    target: { entity_id: "script.movie_time" }
  }
});

// Activate scene
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "scene",
    service: "turn_on",
    target: { entity_id: "scene.romantic_dinner" }
  }
});
```

### Media Players

```typescript
// Play media
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "media_player",
    service: "media_play",
    target: { entity_id: "media_player.living_room" }
  }
});

// Set volume
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "media_player",
    service: "volume_set",
    service_data: { volume_level: 0.5 },
    target: { entity_id: "media_player.living_room" }
  }
});
```

### Notifications

```typescript
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "call_service",
  arguments: {
    domain: "notify",
    service: "notify",
    service_data: {
      message: "Door unlocked!",
      title: "Security Alert"
    }
  }
});
```

### Templates

```typescript
// Calculate total energy usage
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "render_template",
  arguments: {
    template: "{{ states.sensor.power_usage.state | float * 24 }} kWh per day"
  }
});
```

### Shopping & Todo Lists

```typescript
// Add to shopping list
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "manage_shopping_list",
  arguments: {
    action: "add",
    item: "Milk"
  }
});

// Add to custom todo list
use_mcp_tool({
  server_name: "homeassistant",
  tool_name: "manage_todo_lists",
  arguments: {
    action: "add_item",
    entity_id: "todo.my_tasks",
    summary: "Call dentist",
    due_date: "2025-10-05"
  }
});
```

## Important Notes

### Shopping List Implementation
The shopping list functionality in this server uses Home Assistant's todo service rather than the legacy shopping list REST API. This provides better compatibility with modern Home Assistant installations where the shopping list is implemented as a todo entity.

All shopping list operations (add, update, remove, get) use the todo service calls:
- `todo.add_item` - Add items to the shopping list
- `todo.update_item` - Update existing items (mark complete/incomplete, rename)
- `todo.remove_item` - Remove items from the shopping list
- `todo.get_items` - Get all items from the shopping list

**Shopping List Tool**:
- `manage_shopping_list` - Works specifically with the default Home Assistant shopping list (`todo.shopping_list`)

**For Custom Todo Lists**: Use the existing `manage_todo_lists` tool for managing todo list entities themselves, and the `call_service` tool to interact with items in custom lists using the todo service calls.

This ensures reliable functionality and avoids HTTP 405 errors that can occur with the legacy REST API endpoints.

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
