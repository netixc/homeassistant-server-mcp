#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';

const HA_URL = process.env.HA_URL || 'http://192.168.100.250:8123';
const HA_TOKEN = process.env.HA_TOKEN;

if (!HA_TOKEN) {
  throw new Error('HA_TOKEN environment variable is required');
}

class HomeAssistantServer {
  private server: Server;
  private haClient: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'homeassistant-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.haClient = axios.create({
      baseURL: HA_URL,
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_state',
          description: 'Get the current state of a Home Assistant entity',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The entity ID to get state for (e.g., light.living_room)',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'toggle_entity',
          description: 'Toggle a Home Assistant entity on/off',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The entity ID to toggle (e.g., switch.bedroom)',
              },
              state: {
                type: 'string',
                description: 'The desired state (on/off)',
                enum: ['on', 'off'],
              },
            },
            required: ['entity_id', 'state'],
          },
        },
        {
          name: 'trigger_automation',
          description: 'Trigger a Home Assistant automation',
          inputSchema: {
            type: 'object',
            properties: {
              automation_id: {
                type: 'string',
                description: 'The automation ID to trigger (e.g., automation.morning_routine)',
              },
            },
            required: ['automation_id'],
          },
        },
        {
          name: 'run_script',
          description: 'Run a Home Assistant script',
          inputSchema: {
            type: 'object',
            properties: {
              script_id: {
                type: 'string',
                description: 'The script ID to run (e.g., script.open_plex)',
              },
            },
            required: ['script_id'],
          },
        },
        {
          name: 'list_entities',
          description: 'List all available entities in Home Assistant',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Optional domain filter (e.g., light, switch, automation)',
              },
            },
          },
        },
        {
          name: 'control_light',
          description: 'Control a Home Assistant light with advanced features like color, brightness, and temperature',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The light entity ID (e.g., light.living_room)',
              },
              state: {
                type: 'string',
                description: 'Turn the light on or off',
                enum: ['on', 'off'],
              },
              brightness: {
                type: 'number',
                description: 'Brightness level (0-255)',
                minimum: 0,
                maximum: 255,
              },
              rgb_color: {
                type: 'array',
                description: 'RGB color as [red, green, blue] (0-255 each)',
                items: {
                  type: 'number',
                  minimum: 0,
                  maximum: 255,
                },
                minItems: 3,
                maxItems: 3,
              },
              color_temp: {
                type: 'number',
                description: 'Color temperature in mireds (153-500)',
                minimum: 153,
                maximum: 500,
              },
            },
            required: ['entity_id', 'state'],
          },
        },
        {
          name: 'send_remote_command',
          description: 'Send remote control commands to remote entities (TV, Android TV, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The remote entity ID (e.g., remote.tv)',
              },
              command: {
                type: 'string',
                description: 'Remote command to send. Navigation: DPAD_UP/DOWN/LEFT/RIGHT/CENTER, BUTTON_A/B/X/Y, BACK. Volume: VOLUME_UP/DOWN/MUTE. Media: MEDIA_PLAY_PAUSE/PLAY/PAUSE/NEXT/PREVIOUS/STOP/RECORD/REWIND/FAST_FORWARD. Numbers: 0-9. TV: CHANNEL_UP/DOWN, TV, PROG_RED/GREEN/YELLOW/BLUE. Function keys: F1-F12. Other: HOME, MENU, INFO, GUIDE, SETTINGS, SEARCH, POWER, etc.',
              },
            },
            required: ['entity_id', 'command'],
          },
        },
        {
          name: 'launch_app',
          description: 'Launch an app/activity on a remote device (Android TV, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The remote entity ID (e.g., remote.tv)',
              },
              activity: {
                type: 'string',
                description: 'The app package name/activity to launch (e.g., com.plexapp.android)',
              },
            },
            required: ['entity_id', 'activity'],
          },
        },
        {
          name: 'open_streaming_app',
          description: 'Quick launcher for popular streaming apps on TV',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The remote entity ID (e.g., remote.tv)',
              },
              app: {
                type: 'string',
                description: 'The streaming app to open',
                enum: ['plex', 'youtube', 'netflix', 'prime', 'disney'],
              },
            },
            required: ['entity_id', 'app'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'get_state':
            return await this.getEntityState(request.params.arguments);
          case 'toggle_entity':
            return await this.toggleEntity(request.params.arguments);
          case 'trigger_automation':
            return await this.triggerAutomation(request.params.arguments);
          case 'run_script':
            return await this.runScript(request.params.arguments);
          case 'list_entities':
            return await this.listEntities(request.params.arguments);
          case 'control_light':
            return await this.controlLight(request.params.arguments);
          case 'send_remote_command':
            return await this.sendRemoteCommand(request.params.arguments);
          case 'launch_app':
            return await this.launchApp(request.params.arguments);
          case 'open_streaming_app':
            return await this.openStreamingApp(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Home Assistant API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw error;
      }
    });
  }

  private async getEntityState(args: any) {
    if (!args.entity_id) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id is required');
    }

    const response = await this.haClient.get(`/api/states/${args.entity_id}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async toggleEntity(args: any) {
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }

    const response = await this.haClient.post('/api/services/homeassistant/turn_' + args.state, {
      entity_id: args.entity_id,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully turned ${args.state} ${args.entity_id}`,
        },
      ],
    };
  }

  private async triggerAutomation(args: any) {
    if (!args.automation_id) {
      throw new McpError(ErrorCode.InvalidParams, 'automation_id is required');
    }

    const response = await this.haClient.post('/api/services/automation/trigger', {
      entity_id: args.automation_id,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully triggered ${args.automation_id}`,
        },
      ],
    };
  }

  private async runScript(args: any) {
    if (!args.script_id) {
      throw new McpError(ErrorCode.InvalidParams, 'script_id is required');
    }

    const response = await this.haClient.post('/api/services/script/turn_on', {
      entity_id: args.script_id,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully ran ${args.script_id}`,
        },
      ],
    };
  }

  private async listEntities(args: any) {
    const response = await this.haClient.get('/api/states');
    let entities = response.data;

    if (args.domain) {
      entities = entities.filter((entity: any) => 
        entity.entity_id.startsWith(args.domain + '.'));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(entities.map((entity: any) => ({
            entity_id: entity.entity_id,
            state: entity.state,
            attributes: entity.attributes,
          })), null, 2),
        },
      ],
    };
  }

  private async controlLight(args: any) {
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }

    if (!args.entity_id.startsWith('light.')) {
      throw new McpError(ErrorCode.InvalidParams, 'control_light can only be used with light entities (entity_id must start with "light.")');
    }

    if (args.state === 'off') {
      const response = await this.haClient.post('/api/services/light/turn_off', {
        entity_id: args.entity_id,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully turned off ${args.entity_id}`,
          },
        ],
      };
    } else {
      const serviceData: any = {
        entity_id: args.entity_id,
      };

      if (args.brightness !== undefined) {
        serviceData.brightness = args.brightness;
      }

      if (args.rgb_color) {
        serviceData.rgb_color = args.rgb_color;
      }

      if (args.color_temp !== undefined) {
        serviceData.color_temp = args.color_temp;
      }

      const response = await this.haClient.post('/api/services/light/turn_on', serviceData);

      const features = [];
      if (args.brightness !== undefined) features.push(`brightness: ${args.brightness}`);
      if (args.rgb_color) features.push(`color: RGB(${args.rgb_color.join(', ')})`);
      if (args.color_temp !== undefined) features.push(`color_temp: ${args.color_temp} mireds`);

      const featuresText = features.length > 0 ? ` with ${features.join(', ')}` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Successfully turned on ${args.entity_id}${featuresText}`,
          },
        ],
      };
    }
  }

  private async sendRemoteCommand(args: any) {
    if (!args.entity_id || !args.command) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and command are required');
    }

    const response = await this.haClient.post('/api/services/remote/send_command', {
      entity_id: args.entity_id,
      command: args.command,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully sent ${args.command} command to ${args.entity_id}`,
        },
      ],
    };
  }

  private async launchApp(args: any) {
    if (!args.entity_id || !args.activity) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and activity are required');
    }

    const response = await this.haClient.post('/api/services/remote/turn_on', {
      entity_id: args.entity_id,
      activity: args.activity,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully launched ${args.activity} on ${args.entity_id}`,
        },
      ],
    };
  }

  private async openStreamingApp(args: any) {
    if (!args.entity_id || !args.app) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and app are required');
    }

    const appMappings: { [key: string]: string } = {
      'plex': 'com.plexapp.android',
      'youtube': 'https://www.youtube.com',
      'netflix': 'https://www.netflix.com/title',
      'prime': 'https://app.primevideo.com',
      'disney': 'https://www.disneyplus.com'
    };

    const activity = appMappings[args.app];
    if (!activity) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown app: ${args.app}. Available apps: ${Object.keys(appMappings).join(', ')}`);
    }

    const response = await this.haClient.post('/api/services/remote/turn_on', {
      entity_id: args.entity_id,
      activity: activity,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully opened ${args.app} on ${args.entity_id}`,
        },
      ],
    };
  }


  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Home Assistant MCP server running on stdio');
  }
}

const server = new HomeAssistantServer();
server.run().catch(console.error);
