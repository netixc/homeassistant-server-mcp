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
          case 'list_entities':
            return await this.listEntities(request.params.arguments);
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Home Assistant MCP server running on stdio');
  }
}

const server = new HomeAssistantServer();
server.run().catch(console.error);
