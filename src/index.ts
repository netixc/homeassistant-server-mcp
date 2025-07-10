#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import WebSocket from 'ws';

// Parse command line arguments
const args = process.argv.slice(2);
let enabledTools: string[] | null = null;

for (const arg of args) {
  if (arg.startsWith('--tools=')) {
    enabledTools = arg.slice(8).split(',').map(t => t.trim());
  }
}

// Type definitions
interface HomeAssistantEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  friendly_name?: string;
}


interface GetStateArgs {
  entity_id: string;
}

interface ToggleEntityArgs {
  entity_id: string;
  state: 'on' | 'off';
}

interface TriggerAutomationArgs {
  automation_id: string;
}

interface RunScriptArgs {
  script_id: string;
}

interface ListEntitiesArgs {
  domain?: string;
}

interface ControlLightArgs {
  entity_id: string;
  state: 'on' | 'off';
  brightness?: number;
  rgb_color?: [number, number, number];
  color_temp?: number;
}

interface SendRemoteCommandArgs {
  entity_id: string;
  command: string;
}

interface LaunchAppArgs {
  entity_id: string;
  activity: string;
}

interface OpenStreamingAppArgs {
  entity_id: string;
  app: 'plex' | 'youtube' | 'netflix' | 'prime' | 'disney';
}


interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface Config {
  haUrl: string;
  haToken: string;
  rateLimitWindow: number;
  rateLimitMax: number;
  requestTimeout: number;
  retryAttempts: number;
  retryDelay: number;
  streamingApps: Record<string, string>;
}

// Constants
const BRIGHTNESS_MIN = 0;
const BRIGHTNESS_MAX = 255;
const COLOR_TEMP_MIN = 153;
const COLOR_TEMP_MAX = 500;
const RGB_MIN = 0;
const RGB_MAX = 255;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // 100 requests per minute
const REQUEST_TIMEOUT = 5000; // 5 seconds
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // 1 second

const DEFAULT_STREAMING_APPS: Record<string, string> = {
  'plex': 'com.plexapp.android',
  'youtube': 'https://www.youtube.com',
  'netflix': 'https://www.netflix.com/title',
  'prime': 'https://app.primevideo.com',
  'disney': 'https://www.disneyplus.com'
};

const VALID_REMOTE_COMMANDS = new Set([
  // Navigation
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER',
  'BUTTON_A', 'BUTTON_B', 'BUTTON_X', 'BUTTON_Y', 'BACK',
  // Volume
  'VOLUME_UP', 'VOLUME_DOWN', 'MUTE',
  // Media
  'MEDIA_PLAY_PAUSE', 'MEDIA_PLAY', 'MEDIA_PAUSE', 'MEDIA_NEXT', 'MEDIA_PREVIOUS',
  'MEDIA_STOP', 'MEDIA_RECORD', 'MEDIA_REWIND', 'MEDIA_FAST_FORWARD',
  // Numbers
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  // TV
  'CHANNEL_UP', 'CHANNEL_DOWN', 'TV', 'PROG_RED', 'PROG_GREEN', 'PROG_YELLOW', 'PROG_BLUE',
  // Function keys
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // Other
  'HOME', 'MENU', 'INFO', 'GUIDE', 'SETTINGS', 'SEARCH', 'POWER'
]);

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

// Configuration
const config: Config = {
  haUrl: process.env.HA_URL || 'http://192.168.100.250:8123',
  haToken: process.env.HA_TOKEN || '',
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || RATE_LIMIT_WINDOW.toString()),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || RATE_LIMIT_MAX.toString()),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || REQUEST_TIMEOUT.toString()),
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || RETRY_ATTEMPTS.toString()),
  retryDelay: parseInt(process.env.RETRY_DELAY || RETRY_DELAY.toString()),
  streamingApps: { ...DEFAULT_STREAMING_APPS },
};

if (!config.haToken) {
  throw new Error('HA_TOKEN environment variable is required');
}

// Validate HA_URL format
if (!config.haUrl.match(/^https?:\/\/.+/)) {
  throw new Error('HA_URL must be a valid HTTP or HTTPS URL');
}

/**
 * Home Assistant MCP Server
 * 
 * Provides secure, rate-limited access to Home Assistant APIs through MCP tools.
 * Features include device control, automation triggers, and media management.
 * 
 * Security features:
 * - Input validation and sanitization
 * - Rate limiting (configurable)
 * - Request timeouts and retries
 * - Entity ID format validation
 * - Command whitelisting for remote controls
 */
class HomeAssistantServer {
  private server: Server;
  private haClient: AxiosInstance;
  private rateLimitMap: Map<string, RateLimitEntry> = new Map();
  private logLevel: LogLevel = LogLevel.INFO;
  private enabledTools: string[] | null;

  constructor(enabledTools: string[] | null = null) {
    this.enabledTools = enabledTools;
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
      baseURL: config.haUrl,
      timeout: config.requestTimeout,
      headers: {
        Authorization: `Bearer ${config.haToken}`,
        'Content-Type': 'application/json',
      },
    });

    this.setupToolHandlers();
    
    // Log enabled tools
    if (this.enabledTools) {
      this.log(LogLevel.INFO, `Enabled tools: ${this.enabledTools.join(', ')}`);
    } else {
      this.log(LogLevel.INFO, 'All tools enabled');
    }
    
    
    this.server.onerror = (error) => this.log(LogLevel.ERROR, '[MCP Error]', error);
    process.on('SIGINT', async () => {
      this.log(LogLevel.INFO, 'Shutting down server...');
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Logging utility with configurable levels
   */
  private log(level: LogLevel, ...args: any[]): void {
    if (level >= this.logLevel) {
      const timestamp = new Date().toISOString();
      const levelStr = LogLevel[level];
      console.error(`[${timestamp}] [${levelStr}]`, ...args);
    }
  }

  /**
   * Validates entity ID format
   */
  private validateEntityId(entityId: string): boolean {
    return /^[a-z_]+\.[a-z0-9_]+$/.test(entityId);
  }

  /**
   * Sanitizes string input to prevent injection attacks
   */
  private sanitizeInput(input: string): string {
    return input.replace(/[<>"'&]/g, '');
  }

  /**
   * Rate limiting implementation
   */
  private checkRateLimit(clientId: string = 'default'): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(clientId);
    
    if (!entry || now > entry.resetTime) {
      this.rateLimitMap.set(clientId, {
        count: 1,
        resetTime: now + config.rateLimitWindow
      });
      return true;
    }
    
    if (entry.count >= config.rateLimitMax) {
      return false;
    }
    
    entry.count++;
    return true;
  }

  /**
   * Retry wrapper for HTTP requests
   */
  private async withRetry<T>(operation: () => Promise<T>, attempts: number = config.retryAttempts): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === attempts - 1) throw error;
        
        this.log(LogLevel.WARN, `Attempt ${i + 1} failed, retrying in ${config.retryDelay}ms:`, error);
        await new Promise(resolve => setTimeout(resolve, config.retryDelay));
      }
    }
    throw new Error('All retry attempts failed');
  }

  /**
   * Health check for Home Assistant connection
   */
  private async healthCheck(): Promise<boolean> {
    try {
      await this.haClient.get('/api/');
      return true;
    } catch (error) {
      this.log(LogLevel.ERROR, 'Health check failed:', error);
      return false;
    }
  }


  /**
   * Add friendly name to entity if available
   */
  private addFriendlyName(entity: HomeAssistantEntity): HomeAssistantEntity {
    if (entity.attributes && entity.attributes.friendly_name) {
      entity.friendly_name = entity.attributes.friendly_name;
    }
    return entity;
  }

  private setupToolHandlers() {
    // Define all available tools
    const allTools = [
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
        {
          name: 'activate_scene',
          description: 'Activate a Home Assistant scene',
          inputSchema: {
            type: 'object',
            properties: {
              scene_id: {
                type: 'string',
                description: 'The scene ID to activate (e.g., scene.movie_time)',
              },
            },
            required: ['scene_id'],
          },
        },
        {
          name: 'list_scenes',
          description: 'List all available scenes in Home Assistant',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'control_media_player',
          description: 'Control media players with play, pause, volume, and more',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The media player entity ID (e.g., media_player.living_room)',
              },
              action: {
                type: 'string',
                description: 'Action to perform',
                enum: ['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_up', 'volume_down', 'mute', 'unmute', 'toggle'],
              },
              volume_level: {
                type: 'number',
                description: 'Volume level (0.0 to 1.0) for volume_set action',
                minimum: 0,
                maximum: 1,
              },
              media_content_id: {
                type: 'string',
                description: 'Media content ID to play',
              },
              media_content_type: {
                type: 'string',
                description: 'Media content type (music, playlist, video, episode, channel)',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'get_media_player_state',
          description: 'Get detailed state of a media player',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The media player entity ID',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'send_notification',
          description: 'Send notifications through Home Assistant notify services',
          inputSchema: {
            type: 'object',
            properties: {
              service: {
                type: 'string',
                description: 'Notify service name (e.g., notify, mobile_app_phone, alexa_media)',
                default: 'notify',
              },
              title: {
                type: 'string',
                description: 'Notification title',
              },
              message: {
                type: 'string',
                description: 'Notification message (required)',
              },
              target: {
                type: 'string',
                description: 'Target device or entity ID (for specific notify services)',
              },
              data: {
                type: 'object',
                description: 'Additional data for the notification (e.g., actions, image, sound)',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'list_notify_services',
          description: 'List all available notification services',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_sensor_data',
          description: 'Get current sensor data or historical data',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The sensor entity ID (e.g., sensor.temperature)',
              },
              include_history: {
                type: 'boolean',
                description: 'Include historical data',
                default: false,
              },
              start_time: {
                type: 'string',
                description: 'Start time for history (ISO format, e.g., 2025-01-01T00:00:00Z)',
              },
              end_time: {
                type: 'string',
                description: 'End time for history (ISO format, defaults to now)',
              },
              minimal_response: {
                type: 'boolean',
                description: 'Return minimal response with just state values',
                default: false,
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'list_sensors',
          description: 'List all sensor entities with their current values',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Filter by domain (sensor, binary_sensor)',
                enum: ['sensor', 'binary_sensor'],
              },
              device_class: {
                type: 'string',
                description: 'Filter by device class (temperature, humidity, etc.)',
              },
            },
          },
        },
        {
          name: 'call_service',
          description: 'Call any Home Assistant service directly',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Service domain (e.g., light, switch, climate)',
              },
              service: {
                type: 'string',
                description: 'Service name (e.g., turn_on, turn_off, set_temperature)',
              },
              service_data: {
                type: 'object',
                description: 'Service data/parameters',
                default: {},
              },
              target: {
                type: 'object',
                description: 'Service target (entity_id, area_id, device_id)',
                properties: {
                  entity_id: {
                    type: ['string', 'array'],
                    description: 'Entity ID(s) to target',
                  },
                  area_id: {
                    type: ['string', 'array'],
                    description: 'Area ID(s) to target',
                  },
                  device_id: {
                    type: ['string', 'array'],
                    description: 'Device ID(s) to target',
                  },
                },
              },
            },
            required: ['domain', 'service'],
          },
        },
        {
          name: 'list_services',
          description: 'List all available Home Assistant services',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Filter by specific domain',
              },
            },
          },
        },
        {
          name: 'render_template',
          description: 'Render a Home Assistant template and return the result',
          inputSchema: {
            type: 'object',
            properties: {
              template: {
                type: 'string',
                description: 'The Jinja2 template to render (e.g., "{{ states.sensor.temperature.state }}°C")',
              },
              variables: {
                type: 'object',
                description: 'Variables to make available in the template context',
                default: {},
              },
              timeout: {
                type: 'number',
                description: 'Template rendering timeout in seconds',
                default: 5,
                minimum: 1,
                maximum: 30,
              },
            },
            required: ['template'],
          },
        },
        {
          name: 'get_events',
          description: 'Get recent Home Assistant events from the event bus',
          inputSchema: {
            type: 'object',
            properties: {
              event_type: {
                type: 'string',
                description: 'Filter by specific event type (e.g., state_changed, call_service)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of events to return',
                default: 50,
                minimum: 1,
                maximum: 500,
              },
              entity_id: {
                type: 'string',
                description: 'Filter events related to specific entity',
              },
            },
          },
        },
        {
          name: 'fire_event',
          description: 'Fire a custom event on the Home Assistant event bus',
          inputSchema: {
            type: 'object',
            properties: {
              event_type: {
                type: 'string',
                description: 'Event type name',
              },
              event_data: {
                type: 'object',
                description: 'Event data payload',
                default: {},
              },
            },
            required: ['event_type'],
          },
        },
        {
          name: 'backup_management',
          description: 'Manage Home Assistant backups',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'Backup action to perform',
                enum: ['list', 'create', 'download_info', 'delete', 'restore_info'],
              },
              backup_id: {
                type: 'string',
                description: 'Backup ID for specific operations',
              },
              name: {
                type: 'string',
                description: 'Name for new backup',
              },
              password: {
                type: 'string',
                description: 'Password for backup encryption',
              },
              addons: {
                type: 'array',
                description: 'List of addon slugs to include in backup',
                items: { type: 'string' },
              },
              folders: {
                type: 'array',
                description: 'List of folders to include in backup',
                items: { type: 'string' },
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'system_info',
          description: 'Get Home Assistant system information and health status',
          inputSchema: {
            type: 'object',
            properties: {
              include_addons: {
                type: 'boolean',
                description: 'Include addon information',
                default: false,
              },
            },
          },
        },
        {
          name: 'manage_todo_lists',
          description: 'Manage Home Assistant to-do lists',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'Action to perform on to-do lists',
                enum: ['list', 'get_items', 'add_item', 'update_item', 'remove_item', 'create_list_info', 'create_list_ws'],
              },
              entity_id: {
                type: 'string',
                description: 'To-do list entity ID (e.g., todo.shopping_list)',
              },
              item_id: {
                type: 'string',
                description: 'Item ID for update/remove operations',
              },
              item: {
                type: 'string',
                description: 'Item text for add/update operations',
              },
              summary: {
                type: 'string',
                description: 'Item summary/title',
              },
              description: {
                type: 'string',
                description: 'Item description',
              },
              status: {
                type: 'string',
                description: 'Item status for updates',
                enum: ['needs_action', 'completed'],
              },
              due_date: {
                type: 'string',
                description: 'Due date in ISO format (YYYY-MM-DD)',
              },
              list_name: {
                type: 'string',
                description: 'Name for new to-do list (for create_list_info or create_list_ws actions)',
              },
            },
            required: ['action'],
          },
        },
        {
          name: 'manage_shopping_list',
          description: 'Manage the Home Assistant shopping list (legacy support)',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'Shopping list action',
                enum: ['get', 'add', 'update', 'remove', 'clear'],
              },
              item: {
                type: 'string',
                description: 'Item name for add/update/remove operations. For update/remove, this can be used to find the item if item_id is not provided.',
              },
              complete: {
                type: 'boolean',
                description: 'Mark item as complete/incomplete',
              },
              item_id: {
                type: 'string',
                description: 'Item ID for update/remove operations (preferred). If not provided, the system will search by item name.',
              },
              id: {
                type: 'string',
                description: 'Alternative item ID parameter for update/remove operations',
              },
              list_id: {
                type: 'string',
                description: 'Todo list entity ID (e.g., "todo.shopping_list", "todo.my_list"). Defaults to "todo.shopping_list"',
              },
            },
            required: ['action'],
          },
        },
    ];
    
    // Filter tools based on enabledTools list
    const filteredTools = this.enabledTools 
      ? allTools.filter(tool => this.enabledTools!.includes(tool.name))
      : allTools;
    
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: filteredTools
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // Check if tool is enabled
        if (this.enabledTools && !this.enabledTools.includes(request.params.name)) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool '${request.params.name}' is not enabled. Available tools: ${this.enabledTools.join(', ')}`
          );
        }
        
        switch (request.params.name) {
          case 'get_state':
            return await this.getEntityState(request.params.arguments || {});
          case 'toggle_entity':
            return await this.toggleEntity(request.params.arguments || {});
          case 'trigger_automation':
            return await this.triggerAutomation(request.params.arguments || {});
          case 'run_script':
            return await this.runScript(request.params.arguments || {});
          case 'list_entities':
            return await this.listEntities(request.params.arguments || {});
          case 'control_light':
            return await this.controlLight(request.params.arguments || {});
          case 'send_remote_command':
            return await this.sendRemoteCommand(request.params.arguments || {});
          case 'launch_app':
            return await this.launchApp(request.params.arguments || {});
          case 'open_streaming_app':
            return await this.openStreamingApp(request.params.arguments || {});
          case 'activate_scene':
            return await this.activateScene(request.params.arguments || {});
          case 'list_scenes':
            return await this.listScenes(request.params.arguments || {});
          case 'control_media_player':
            return await this.controlMediaPlayer(request.params.arguments || {});
          case 'get_media_player_state':
            return await this.getMediaPlayerState(request.params.arguments || {});
          case 'send_notification':
            return await this.sendNotification(request.params.arguments || {});
          case 'list_notify_services':
            return await this.listNotifyServices(request.params.arguments || {});
          case 'get_sensor_data':
            return await this.getSensorData(request.params.arguments || {});
          case 'list_sensors':
            return await this.listSensors(request.params.arguments || {});
          case 'call_service':
            return await this.callService(request.params.arguments || {});
          case 'list_services':
            return await this.listServices(request.params.arguments || {});
          case 'render_template':
            return await this.renderTemplate(request.params.arguments || {});
          case 'get_events':
            return await this.getEvents(request.params.arguments || {});
          case 'fire_event':
            return await this.fireEvent(request.params.arguments || {});
          case 'backup_management':
            return await this.backupManagement(request.params.arguments || {});
          case 'system_info':
            return await this.getSystemInfo(request.params.arguments || {});
          case 'manage_todo_lists':
            return await this.manageTodoLists(request.params.arguments || {});
          case 'manage_shopping_list':
            return await this.manageShoppingList(request.params.arguments || {});
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const message = error.response?.status === 401 ? 'Authentication failed' : 
                         error.response?.status === 404 ? 'Entity not found' :
                         'Home Assistant API error';
          
          this.log(LogLevel.ERROR, 'API Error:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data
          });
          
          throw new McpError(ErrorCode.InternalError, message);
        }
        throw error;
      }
    });
  }

  private async getEntityState(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id is required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format');
    }


    const response = await this.withRetry(() => 
      this.haClient.get(`/api/states/${sanitizedEntityId}`)
    );
    
    const entity = this.addFriendlyName(response.data);
    
    this.log(LogLevel.DEBUG, `Got state for ${sanitizedEntityId}:`, entity);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(entity, null, 2),
        },
      ],
    };
  }

  private async toggleEntity(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format');
    }
    
    if (!['on', 'off'].includes(args.state)) {
      throw new McpError(ErrorCode.InvalidParams, 'state must be "on" or "off"');
    }
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/homeassistant/turn_' + args.state, {
        entity_id: sanitizedEntityId,
      })
    );

    this.log(LogLevel.INFO, `Turned ${args.state} ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully turned ${args.state} ${sanitizedEntityId}`,
        },
      ],
    };
  }

  private async triggerAutomation(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.automation_id) {
      throw new McpError(ErrorCode.InvalidParams, 'automation_id is required');
    }
    
    const sanitizedAutomationId = this.sanitizeInput(args.automation_id);
    if (!this.validateEntityId(sanitizedAutomationId) || !sanitizedAutomationId.startsWith('automation.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid automation_id format');
    }
    if (!args.automation_id) {
      throw new McpError(ErrorCode.InvalidParams, 'automation_id is required');
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/automation/trigger', {
        entity_id: sanitizedAutomationId,
      })
    );

    this.log(LogLevel.INFO, `Triggered automation ${sanitizedAutomationId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully triggered ${sanitizedAutomationId}`,
        },
      ],
    };
  }

  private async runScript(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.script_id) {
      throw new McpError(ErrorCode.InvalidParams, 'script_id is required');
    }
    
    const sanitizedScriptId = this.sanitizeInput(args.script_id);
    if (!this.validateEntityId(sanitizedScriptId) || !sanitizedScriptId.startsWith('script.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid script_id format');
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/script/turn_on', {
        entity_id: sanitizedScriptId,
      })
    );

    this.log(LogLevel.INFO, `Ran script ${sanitizedScriptId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully ran ${sanitizedScriptId}`,
        },
      ],
    };
  }

  private async listEntities(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    const response = await this.withRetry(() => 
      this.haClient.get('/api/states')
    );
    
    let entities: HomeAssistantEntity[] = response.data;

    if (args.domain) {
      const sanitizedDomain = this.sanitizeInput(args.domain);
      if (!/^[a-z_]+$/.test(sanitizedDomain)) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid domain format');
      }
      entities = entities.filter((entity: HomeAssistantEntity) => 
        entity.entity_id.startsWith(sanitizedDomain + '.'));
    }
    
    // Add friendly names and update cache
    entities = entities.map((entity: HomeAssistantEntity) => {
      const entityWithName = this.addFriendlyName(entity);
      return entityWithName;
    });
    
    this.log(LogLevel.DEBUG, `Listed ${entities.length} entities${args.domain ? ` for domain ${args.domain}` : ''}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(entities.map((entity: HomeAssistantEntity) => ({
            entity_id: entity.entity_id,
            friendly_name: entity.friendly_name,
            state: entity.state,
            attributes: entity.attributes,
          })), null, 2),
        },
      ],
    };
  }

  private async controlLight(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format');
    }
    if (!args.entity_id || !args.state) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and state are required');
    }

    if (!sanitizedEntityId.startsWith('light.')) {
      throw new McpError(ErrorCode.InvalidParams, 'control_light can only be used with light entities (entity_id must start with "light.")');
    }
    
    if (!['on', 'off'].includes(args.state)) {
      throw new McpError(ErrorCode.InvalidParams, 'state must be "on" or "off"');
    }
    
    // Validate optional parameters
    if (args.brightness !== undefined && (args.brightness < BRIGHTNESS_MIN || args.brightness > BRIGHTNESS_MAX)) {
      throw new McpError(ErrorCode.InvalidParams, `brightness must be between ${BRIGHTNESS_MIN} and ${BRIGHTNESS_MAX}`);
    }
    
    if (args.color_temp !== undefined && (args.color_temp < COLOR_TEMP_MIN || args.color_temp > COLOR_TEMP_MAX)) {
      throw new McpError(ErrorCode.InvalidParams, `color_temp must be between ${COLOR_TEMP_MIN} and ${COLOR_TEMP_MAX}`);
    }
    
    if (args.rgb_color && (!Array.isArray(args.rgb_color) || args.rgb_color.length !== 3 || 
        args.rgb_color.some((c: number) => c < RGB_MIN || c > RGB_MAX))) {
      throw new McpError(ErrorCode.InvalidParams, `rgb_color must be an array of 3 numbers between ${RGB_MIN} and ${RGB_MAX}`);
    }

    if (args.state === 'off') {
      const response = await this.withRetry(() => 
        this.haClient.post('/api/services/light/turn_off', {
          entity_id: sanitizedEntityId,
        })
      );

      this.log(LogLevel.INFO, `Turned off light ${sanitizedEntityId}`);
      
      return {
        content: [
          {
            type: 'text',
            text: `Successfully turned off ${sanitizedEntityId}`,
          },
        ],
      };
    } else {
      const serviceData: Record<string, any> = {
        entity_id: sanitizedEntityId,
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

      const response = await this.withRetry(() => 
        this.haClient.post('/api/services/light/turn_on', serviceData)
      );
      
      this.log(LogLevel.INFO, `Turned on light ${sanitizedEntityId}`, serviceData);

      const features = [];
      if (args.brightness !== undefined) features.push(`brightness: ${args.brightness}`);
      if (args.rgb_color) features.push(`color: RGB(${args.rgb_color.join(', ')})`);
      if (args.color_temp !== undefined) features.push(`color_temp: ${args.color_temp} mireds`);

      const featuresText = features.length > 0 ? ` with ${features.join(', ')}` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Successfully turned on ${sanitizedEntityId}${featuresText}`,
          },
        ],
      };
    }
  }

  private async sendRemoteCommand(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.command) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and command are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    const sanitizedCommand = this.sanitizeInput(args.command);
    
    if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('remote.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format or not a remote entity');
    }
    
    if (!VALID_REMOTE_COMMANDS.has(sanitizedCommand)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid remote command. Valid commands: ${Array.from(VALID_REMOTE_COMMANDS).join(', ')}`);
    }
    if (!args.entity_id || !args.command) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and command are required');
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/remote/send_command', {
        entity_id: sanitizedEntityId,
        command: sanitizedCommand,
      })
    );

    this.log(LogLevel.INFO, `Sent command ${sanitizedCommand} to ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully sent ${sanitizedCommand} command to ${sanitizedEntityId}`,
        },
      ],
    };
  }

  private async launchApp(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.activity) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and activity are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    const sanitizedActivity = this.sanitizeInput(args.activity);
    
    if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('remote.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format or not a remote entity');
    }
    if (!args.entity_id || !args.activity) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and activity are required');
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/remote/turn_on', {
        entity_id: sanitizedEntityId,
        activity: sanitizedActivity,
      })
    );

    this.log(LogLevel.INFO, `Launched ${sanitizedActivity} on ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully launched ${sanitizedActivity} on ${sanitizedEntityId}`,
        },
      ],
    };
  }

  private async openStreamingApp(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.app) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and app are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    
    if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('remote.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format or not a remote entity');
    }

    const activity = config.streamingApps[args.app];
    if (!activity) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown app: ${args.app}. Available apps: ${Object.keys(config.streamingApps).join(', ')}`);
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/remote/turn_on', {
        entity_id: sanitizedEntityId,
        activity: activity,
      })
    );

    this.log(LogLevel.INFO, `Opened ${args.app} on ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully opened ${args.app} on ${sanitizedEntityId}`,
        },
      ],
    };
  }


  private async activateScene(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.scene_id) {
      throw new McpError(ErrorCode.InvalidParams, 'scene_id is required');
    }
    
    const sanitizedSceneId = this.sanitizeInput(args.scene_id);
    if (!this.validateEntityId(sanitizedSceneId) || !sanitizedSceneId.startsWith('scene.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid scene_id format. Must start with "scene."');
    }

    // First check if scene exists
    try {
      await this.haClient.get(`/api/states/${sanitizedSceneId}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new McpError(ErrorCode.InvalidParams, `Scene ${sanitizedSceneId} not found`);
      }
      throw error;
    }

    const response = await this.withRetry(() => 
      this.haClient.post('/api/services/scene/turn_on', {
        entity_id: sanitizedSceneId,
      })
    );

    this.log(LogLevel.INFO, `Activated scene ${sanitizedSceneId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully activated scene ${sanitizedSceneId}`,
        },
      ],
    };
  }

  private async listScenes(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }

    const response = await this.withRetry(() => 
      this.haClient.get('/api/states')
    );
    
    let scenes: HomeAssistantEntity[] = response.data;
    
    // Filter for scene entities only
    scenes = scenes.filter((entity: HomeAssistantEntity) => 
      entity.entity_id.startsWith('scene.'))
      .map((scene: HomeAssistantEntity) => {
        const sceneWithName = this.addFriendlyName(scene);
        return sceneWithName;
      });
    
    this.log(LogLevel.DEBUG, `Listed ${scenes.length} scenes`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(scenes.map((scene: HomeAssistantEntity) => ({
            scene_id: scene.entity_id,
            friendly_name: scene.friendly_name || scene.entity_id.replace('scene.', '').replace(/_/g, ' '),
            last_changed: scene.last_changed,
            attributes: scene.attributes,
          })), null, 2),
        },
      ],
    };
  }

  private async controlMediaPlayer(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id || !args.action) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id and action are required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('media_player.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format. Must start with "media_player."');
    }

    let serviceName: string;
    const serviceData: any = {
      entity_id: sanitizedEntityId,
    };

    switch (args.action) {
      case 'play':
        serviceName = 'media_play';
        break;
      case 'pause':
        serviceName = 'media_pause';
        break;
      case 'stop':
        serviceName = 'media_stop';
        break;
      case 'next':
        serviceName = 'media_next_track';
        break;
      case 'previous':
        serviceName = 'media_previous_track';
        break;
      case 'toggle':
        serviceName = 'media_play_pause';
        break;
      case 'volume_set':
        if (args.volume_level === undefined || args.volume_level < 0 || args.volume_level > 1) {
          throw new McpError(ErrorCode.InvalidParams, 'volume_level must be between 0.0 and 1.0 for volume_set');
        }
        serviceName = 'volume_set';
        serviceData.volume_level = args.volume_level;
        break;
      case 'volume_up':
        serviceName = 'volume_up';
        break;
      case 'volume_down':
        serviceName = 'volume_down';
        break;
      case 'mute':
        serviceName = 'volume_mute';
        serviceData.is_volume_muted = true;
        break;
      case 'unmute':
        serviceName = 'volume_mute';
        serviceData.is_volume_muted = false;
        break;
      default:
        throw new McpError(ErrorCode.InvalidParams, `Invalid action: ${args.action}`);
    }

    // Handle media content playback
    if (args.media_content_id) {
      serviceName = 'play_media';
      serviceData.media_content_id = args.media_content_id;
      serviceData.media_content_type = args.media_content_type || 'music';
    }

    const response = await this.withRetry(() => 
      this.haClient.post(`/api/services/media_player/${serviceName}`, serviceData)
    );

    this.log(LogLevel.INFO, `Media player ${sanitizedEntityId}: ${args.action}`);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully performed ${args.action} on ${sanitizedEntityId}`,
        },
      ],
    };
  }

  private async getMediaPlayerState(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id is required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('media_player.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format. Must start with "media_player."');
    }


    const response = await this.withRetry(() => 
      this.haClient.get(`/api/states/${sanitizedEntityId}`)
    );
    
    const entity = this.addFriendlyName(response.data);
    
    this.log(LogLevel.DEBUG, `Got media player state for ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(this.formatMediaPlayerState(entity), null, 2),
        },
      ],
    };
  }

  private formatMediaPlayerState(entity: HomeAssistantEntity): any {
    const attributes = entity.attributes || {};
    return {
      entity_id: entity.entity_id,
      friendly_name: entity.friendly_name,
      state: entity.state,
      volume_level: attributes.volume_level,
      is_volume_muted: attributes.is_volume_muted,
      media_content_type: attributes.media_content_type,
      media_title: attributes.media_title,
      media_artist: attributes.media_artist,
      media_album_name: attributes.media_album_name,
      media_duration: attributes.media_duration,
      media_position: attributes.media_position,
      source: attributes.source,
      source_list: attributes.source_list,
      shuffle: attributes.shuffle,
      repeat: attributes.repeat,
      supported_features: attributes.supported_features,
    };
  }

  private async sendNotification(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.message) {
      throw new McpError(ErrorCode.InvalidParams, 'message is required');
    }
    
    const service = args.service || 'notify';
    const sanitizedService = this.sanitizeInput(service);
    
    // Validate service name format
    if (!/^[a-z0-9_]+$/.test(sanitizedService)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid service name format');
    }

    const notificationData: any = {
      message: args.message,
    };

    if (args.title) {
      notificationData.title = args.title;
    }

    if (args.target) {
      notificationData.target = args.target;
    }

    // Merge additional data if provided
    if (args.data && typeof args.data === 'object') {
      Object.assign(notificationData, args.data);
    }

    try {
      const response = await this.withRetry(() => 
        this.haClient.post(`/api/services/notify/${sanitizedService}`, notificationData)
      );

      this.log(LogLevel.INFO, `Sent notification via ${sanitizedService}`);
      
      return {
        content: [
          {
            type: 'text',
            text: `Notification sent successfully via ${sanitizedService}`,
          },
        ],
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        // Try with the base notify service if specific service fails
        if (sanitizedService !== 'notify') {
          this.log(LogLevel.WARN, `Service notify.${sanitizedService} not found, trying notify.notify`);
          
          const fallbackResponse = await this.withRetry(() => 
            this.haClient.post('/api/services/notify/notify', notificationData)
          );
          
          return {
            content: [
              {
                type: 'text',
                text: 'Notification sent via default notify service',
              },
            ],
          };
        }
      }
      throw error;
    }
  }

  private async listNotifyServices(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }

    try {
      // Get all services
      const response = await this.withRetry(() => 
        this.haClient.get('/api/services')
      );
      
      const services = response.data;
      const notifyServices: any[] = [];
      
      // Extract notify domain services
      if (services.notify) {
        Object.entries(services.notify).forEach(([serviceName, serviceData]: [string, any]) => {
          notifyServices.push({
            service: serviceName === 'notify' ? 'notify' : serviceName,
            full_name: `notify.${serviceName}`,
            description: serviceData.description || `Send notifications via ${serviceName}`,
            fields: serviceData.fields || {},
          });
        });
      }
      
      this.log(LogLevel.DEBUG, `Found ${notifyServices.length} notify services`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(notifyServices, null, 2),
          },
        ],
      };
    } catch (error) {
      this.log(LogLevel.WARN, 'Could not list notify services, returning common ones');
      
      // Return common notify services if listing fails
      const commonServices = [
        {
          service: 'notify',
          full_name: 'notify.notify',
          description: 'Default notification service',
        },
        {
          service: 'persistent_notification',
          full_name: 'notify.persistent_notification',
          description: 'Create persistent notifications in Home Assistant UI',
        },
      ];
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(commonServices, null, 2),
          },
        ],
      };
    }
  }

  private async getSensorData(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.entity_id) {
      throw new McpError(ErrorCode.InvalidParams, 'entity_id is required');
    }
    
    const sanitizedEntityId = this.sanitizeInput(args.entity_id);
    if (!this.validateEntityId(sanitizedEntityId)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid entity_id format');
    }

    // Validate entity is a sensor or binary_sensor
    if (!sanitizedEntityId.startsWith('sensor.') && !sanitizedEntityId.startsWith('binary_sensor.')) {
      throw new McpError(ErrorCode.InvalidParams, 'Entity must be a sensor or binary_sensor');
    }

    const result: any = {
      entity_id: sanitizedEntityId,
    };

    // Get current state
    const stateResponse = await this.withRetry(() => 
      this.haClient.get(`/api/states/${sanitizedEntityId}`)
    );
    const currentEntity = this.addFriendlyName(stateResponse.data);

    result.current = this.formatSensorData(currentEntity, args.minimal_response);

    // Get historical data if requested
    if (args.include_history) {
      try {
        const historyUrl = `/api/history/period${args.start_time ? '/' + args.start_time : ''}`;
        const historyParams: any = {
          filter_entity_id: sanitizedEntityId,
        };
        
        if (args.end_time) {
          historyParams.end_time = args.end_time;
        }

        const historyResponse = await this.withRetry(() => 
          this.haClient.get(historyUrl, { params: historyParams })
        );

        const historyData = historyResponse.data[0] || [];
        
        if (args.minimal_response) {
          result.history = historyData.map((entry: any) => ({
            time: entry.last_changed,
            state: entry.state,
          }));
        } else {
          result.history = historyData;
        }
        
        result.history_count = historyData.length;
      } catch (error) {
        this.log(LogLevel.WARN, `Could not fetch history for ${sanitizedEntityId}:`, error);
        result.history_error = 'Could not fetch historical data';
      }
    }

    this.log(LogLevel.DEBUG, `Got sensor data for ${sanitizedEntityId}`);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async listSensors(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }

    const response = await this.withRetry(() => 
      this.haClient.get('/api/states')
    );
    
    let sensors: HomeAssistantEntity[] = response.data;
    
    // Filter for sensor entities
    const domainFilter = args.domain;
    if (domainFilter) {
      sensors = sensors.filter((entity: HomeAssistantEntity) => 
        entity.entity_id.startsWith(domainFilter + '.'));
    } else {
      // Default to both sensor and binary_sensor
      sensors = sensors.filter((entity: HomeAssistantEntity) => 
        entity.entity_id.startsWith('sensor.') || entity.entity_id.startsWith('binary_sensor.'));
    }

    // Filter by device class if specified
    if (args.device_class) {
      sensors = sensors.filter((entity: HomeAssistantEntity) => 
        entity.attributes && entity.attributes.device_class === args.device_class);
    }
    
    // Add friendly names and update cache
    sensors = sensors.map((sensor: HomeAssistantEntity) => {
      const sensorWithName = this.addFriendlyName(sensor);
      return sensorWithName;
    });
    
    this.log(LogLevel.DEBUG, `Listed ${sensors.length} sensors`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sensors.map((sensor: HomeAssistantEntity) => 
            this.formatSensorData(sensor, false)
          ), null, 2),
        },
      ],
    };
  }

  private formatSensorData(entity: HomeAssistantEntity, minimal: boolean = false): any {
    const attributes = entity.attributes || {};
    
    if (minimal) {
      return {
        entity_id: entity.entity_id,
        state: entity.state,
        unit: attributes.unit_of_measurement,
        last_changed: entity.last_changed,
      };
    }
    
    return {
      entity_id: entity.entity_id,
      friendly_name: entity.friendly_name,
      state: entity.state,
      unit_of_measurement: attributes.unit_of_measurement,
      device_class: attributes.device_class,
      state_class: attributes.state_class,
      icon: attributes.icon,
      last_changed: entity.last_changed,
      last_updated: entity.last_updated,
      attributes: attributes,
    };
  }

  private async callService(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.domain || !args.service) {
      throw new McpError(ErrorCode.InvalidParams, 'domain and service are required');
    }
    
    const sanitizedDomain = this.sanitizeInput(args.domain);
    const sanitizedService = this.sanitizeInput(args.service);
    
    // Validate domain and service format
    if (!/^[a-z0-9_]+$/.test(sanitizedDomain) || !/^[a-z0-9_]+$/.test(sanitizedService)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid domain or service name format');
    }

    // Prepare service call data
    const serviceCallData: any = {};
    
    // Add service data if provided
    if (args.service_data && typeof args.service_data === 'object') {
      Object.assign(serviceCallData, args.service_data);
    }
    
    // Add target if provided (new Home Assistant format)
    if (args.target && typeof args.target === 'object') {
      // Validate entity IDs in target if present
      if (args.target.entity_id) {
        const entityIds = Array.isArray(args.target.entity_id) ? args.target.entity_id : [args.target.entity_id];
        for (const entityId of entityIds) {
          const sanitizedEntityId = this.sanitizeInput(entityId);
          if (!this.validateEntityId(sanitizedEntityId)) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid entity_id format: ${entityId}`);
          }
        }
      }
      
      Object.assign(serviceCallData, args.target);
    }

    // Security check: prevent potentially dangerous service calls
    const dangerousServices = [
      'homeassistant.restart',
      'homeassistant.stop',
      'recorder.purge',
      'system_log.clear',
    ];
    
    const fullServiceName = `${sanitizedDomain}.${sanitizedService}`;
    if (dangerousServices.includes(fullServiceName)) {
      this.log(LogLevel.WARN, `Blocked potentially dangerous service call: ${fullServiceName}`);
      throw new McpError(ErrorCode.InvalidParams, `Service ${fullServiceName} is not allowed for security reasons`);
    }

    try {
      const response = await this.withRetry(() => 
        this.haClient.post(`/api/services/${sanitizedDomain}/${sanitizedService}`, serviceCallData)
      );

      this.log(LogLevel.INFO, `Called service ${fullServiceName}`);
      
      // Return service response data if available
      const responseData = response.data;
      let resultText = `Service ${fullServiceName} called successfully`;
      
      if (responseData && responseData.length > 0) {
        resultText += `\n\nResponse: ${JSON.stringify(responseData, null, 2)}`;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 400) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid service call: ${error.response?.data?.message || 'Bad request'}`);
        } else if (status === 404) {
          throw new McpError(ErrorCode.InvalidParams, `Service ${fullServiceName} not found`);
        }
      }
      throw error;
    }
  }

  private async listServices(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }

    try {
      const response = await this.withRetry(() => 
        this.haClient.get('/api/services')
      );
      
      const allServices = response.data;
      let servicesToReturn: any = {};
      
      if (args.domain) {
        const sanitizedDomain = this.sanitizeInput(args.domain);
        if (allServices[sanitizedDomain]) {
          servicesToReturn[sanitizedDomain] = allServices[sanitizedDomain];
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Domain ${sanitizedDomain} not found`);
        }
      } else {
        servicesToReturn = allServices;
      }
      
      // Format services for better readability
      const formattedServices: any[] = [];
      
      Object.entries(servicesToReturn).forEach(([domain, services]: [string, any]) => {
        Object.entries(services).forEach(([serviceName, serviceData]: [string, any]) => {
          formattedServices.push({
            domain,
            service: serviceName,
            full_name: `${domain}.${serviceName}`,
            description: serviceData.description || `${domain} ${serviceName} service`,
            fields: serviceData.fields || {},
            target: serviceData.target || null,
          });
        });
      });
      
      this.log(LogLevel.DEBUG, `Listed ${formattedServices.length} services${args.domain ? ` for domain ${args.domain}` : ''}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedServices, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(ErrorCode.InternalError, 'Failed to list services');
    }
  }

  private async renderTemplate(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.template) {
      throw new McpError(ErrorCode.InvalidParams, 'template is required');
    }
    
    // Basic template security: prevent potentially dangerous operations
    const template = args.template.toString();
    const dangerousPatterns = [
      '__import__',
      'eval(',
      'exec(',
      'subprocess',
      'os.',
      'open(',
      'file(',
      'input(',
      'raw_input(',
    ];
    
    for (const pattern of dangerousPatterns) {
      if (template.toLowerCase().includes(pattern)) {
        throw new McpError(ErrorCode.InvalidParams, `Template contains potentially dangerous operation: ${pattern}`);
      }
    }
    
    // Limit template length
    if (template.length > 10000) {
      throw new McpError(ErrorCode.InvalidParams, 'Template too long (max 10000 characters)');
    }

    const templateData: any = {
      template: template,
    };
    
    // Add variables if provided
    if (args.variables && typeof args.variables === 'object') {
      templateData.variables = args.variables;
    }
    
    // Set timeout
    const timeout = args.timeout || 5;
    if (timeout < 1 || timeout > 30) {
      throw new McpError(ErrorCode.InvalidParams, 'Timeout must be between 1 and 30 seconds');
    }

    try {
      const response = await this.withRetry(() => 
        this.haClient.post('/api/template', templateData, {
          timeout: timeout * 1000 // Convert to milliseconds
        })
      );

      const result = response.data;
      
      this.log(LogLevel.DEBUG, 'Template rendered successfully');
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              template: template,
              result: result,
              variables: args.variables || {},
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        if (status === 400) {
          const errorMessage = typeof errorData === 'object' && errorData.message 
            ? errorData.message 
            : 'Template syntax error or invalid template';
          throw new McpError(ErrorCode.InvalidParams, `Template error: ${errorMessage}`);
        } else if (status === 504 || error.code === 'ECONNABORTED') {
          throw new McpError(ErrorCode.InternalError, 'Template rendering timed out');
        }
      }
      
      this.log(LogLevel.ERROR, 'Template rendering failed:', error);
      throw new McpError(ErrorCode.InternalError, 'Failed to render template');
    }
  }

  private async getEvents(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    // Note: Home Assistant doesn't have a direct API to get recent events,
    // so we'll use the logbook API which captures most important events
    const limit = Math.min(args.limit || 50, 500);
    
    try {
      // Use logbook API to get recent events
      const response = await this.withRetry(() => 
        this.haClient.get('/api/logbook', {
          params: {
            end_time: new Date().toISOString(),
            // Get events from the last hour by default
            start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          }
        })
      );

      let events = response.data || [];
      
      // Filter by event type if specified
      if (args.event_type) {
        const eventType = args.event_type.toLowerCase();
        events = events.filter((event: any) => {
          // Map logbook event types to Home Assistant event types
          const domain = event.domain || '';
          const eventName = event.name || '';
          
          if (eventType === 'state_changed' && domain) {
            return true;
          }
          if (eventType === 'call_service' && event.message && event.message.includes('turned')){
            return true;
          }
          
          return eventName.toLowerCase().includes(eventType) || 
                 domain.toLowerCase().includes(eventType);
        });
      }
      
      // Filter by entity_id if specified
      if (args.entity_id) {
        const sanitizedEntityId = this.sanitizeInput(args.entity_id);
        events = events.filter((event: any) => 
          event.entity_id === sanitizedEntityId
        );
      }
      
      // Limit results
      events = events.slice(0, limit);
      
      // Format events
      const formattedEvents = events.map((event: any) => ({
        when: event.when,
        entity_id: event.entity_id,
        domain: event.domain,
        name: event.name,
        message: event.message,
        state: event.state,
        icon: event.icon,
        source: event.source,
      }));
      
      this.log(LogLevel.DEBUG, `Retrieved ${formattedEvents.length} events`);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              events: formattedEvents,
              total_count: formattedEvents.length,
              filters_applied: {
                event_type: args.event_type || null,
                entity_id: args.entity_id || null,
                limit: limit,
              }
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      this.log(LogLevel.ERROR, 'Failed to get events:', error);
      throw new McpError(ErrorCode.InternalError, 'Failed to retrieve events');
    }
  }

  private async fireEvent(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.event_type) {
      throw new McpError(ErrorCode.InvalidParams, 'event_type is required');
    }
    
    const eventType = this.sanitizeInput(args.event_type);
    
    // Validate event type format
    if (!/^[a-z0-9_]+$/.test(eventType)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid event_type format. Use only lowercase letters, numbers, and underscores.');
    }
    
    // Prevent firing system events that could cause issues
    const restrictedEvents = [
      'homeassistant_start',
      'homeassistant_stop',
      'homeassistant_close',
      'service_registered',
      'service_removed',
      'platform_discovered',
      'component_loaded',
    ];
    
    if (restrictedEvents.includes(eventType)) {
      throw new McpError(ErrorCode.InvalidParams, `Cannot fire restricted system event: ${eventType}`);
    }
    
    const eventData = args.event_data || {};
    
    // Validate event data is an object
    if (typeof eventData !== 'object' || Array.isArray(eventData)) {
      throw new McpError(ErrorCode.InvalidParams, 'event_data must be an object');
    }

    try {
      const response = await this.withRetry(() => 
        this.haClient.post(`/api/events/${eventType}`, eventData)
      );

      this.log(LogLevel.INFO, `Fired event ${eventType}`);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              event_fired: true,
              event_type: eventType,
              event_data: eventData,
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 400) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid event data: ${error.response?.data?.message || 'Bad request'}`);
        }
      }
      
      this.log(LogLevel.ERROR, `Failed to fire event ${eventType}:`, error);
      throw new McpError(ErrorCode.InternalError, 'Failed to fire event');
    }
  }

  private async backupManagement(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.action) {
      throw new McpError(ErrorCode.InvalidParams, 'action is required');
    }
    
    try {
      switch (args.action) {
        case 'list':
          const listResponse = await this.withRetry(() => 
            this.haClient.get('/api/hassio/backups')
          );
          
          const backups = listResponse.data?.data?.backups || [];
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  backups: backups.map((backup: any) => ({
                    slug: backup.slug,
                    name: backup.name,
                    date: backup.date,
                    type: backup.type,
                    size: backup.size,
                    protected: backup.protected,
                  })),
                  total_count: backups.length,
                }, null, 2),
              },
            ],
          };
          
        case 'create':
          const createData: any = {};
          
          if (args.name) {
            createData.name = args.name;
          }
          
          if (args.password) {
            createData.password = args.password;
          }
          
          if (args.addons && Array.isArray(args.addons)) {
            createData.addons = args.addons;
          }
          
          if (args.folders && Array.isArray(args.folders)) {
            createData.folders = args.folders;
          }
          
          const createResponse = await this.withRetry(() => 
            this.haClient.post('/api/hassio/backups/new/full', createData)
          );
          
          this.log(LogLevel.INFO, 'Backup creation initiated');
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  backup_initiated: true,
                  job_id: createResponse.data?.data?.job_id,
                  message: 'Backup creation started. This may take several minutes.',
                }, null, 2),
              },
            ],
          };
          
        case 'download_info':
        case 'restore_info':
          if (!args.backup_id) {
            throw new McpError(ErrorCode.InvalidParams, 'backup_id is required for this action');
          }
          
          const infoResponse = await this.withRetry(() => 
            this.haClient.get(`/api/hassio/backups/${args.backup_id}/info`)
          );
          
          const backupInfo = infoResponse.data?.data;
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  backup_id: args.backup_id,
                  info: backupInfo,
                  download_url: args.action === 'download_info' ? `/api/hassio/backups/${args.backup_id}/download` : undefined,
                }, null, 2),
              },
            ],
          };
          
        case 'delete':
          if (!args.backup_id) {
            throw new McpError(ErrorCode.InvalidParams, 'backup_id is required for delete action');
          }
          
          await this.withRetry(() => 
            this.haClient.delete(`/api/hassio/backups/${args.backup_id}`)
          );
          
          this.log(LogLevel.INFO, `Deleted backup ${args.backup_id}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  deleted: true,
                  backup_id: args.backup_id,
                }, null, 2),
              },
            ],
          };
          
        default:
          throw new McpError(ErrorCode.InvalidParams, `Invalid action: ${args.action}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new McpError(ErrorCode.InvalidParams, 'Backup not found or Supervisor not available');
        } else if (status === 400) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid backup operation: ${error.response?.data?.message || 'Bad request'}`);
        }
      }
      
      this.log(LogLevel.ERROR, 'Backup operation failed:', error);
      throw new McpError(ErrorCode.InternalError, 'Backup operation failed');
    }
  }

  private async getSystemInfo(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    try {
      // Get basic system info
      const [configResponse, coreResponse] = await Promise.all([
        this.withRetry(() => this.haClient.get('/api/config')),
        this.withRetry(() => this.haClient.get('/api/')),
      ]);
      
      const systemInfo: any = {
        core: {
          version: coreResponse.data?.version,
          installation_type: configResponse.data?.installation_type,
          location_name: configResponse.data?.location_name,
          time_zone: configResponse.data?.time_zone,
          unit_system: configResponse.data?.unit_system,
          latitude: configResponse.data?.latitude,
          longitude: configResponse.data?.longitude,
          elevation: configResponse.data?.elevation,
        },
        components: configResponse.data?.components?.length || 0,
        entities: configResponse.data?.entities?.length || 0,
        state: configResponse.data?.state,
        external_url: configResponse.data?.external_url,
        internal_url: configResponse.data?.internal_url,
      };
      
      // Try to get supervisor info if available
      try {
        const supervisorResponse = await this.withRetry(() => 
          this.haClient.get('/api/hassio/info')
        );
        
        systemInfo.supervisor = {
          version: supervisorResponse.data?.data?.supervisor,
          supported: supervisorResponse.data?.data?.supported,
          healthy: supervisorResponse.data?.data?.healthy,
          arch: supervisorResponse.data?.data?.arch,
          operating_system: supervisorResponse.data?.data?.operating_system,
        };
        
        // Get addon info if requested
        if (args.include_addons) {
          try {
            const addonsResponse = await this.withRetry(() => 
              this.haClient.get('/api/hassio/addons')
            );
            
            systemInfo.addons = addonsResponse.data?.data?.addons || [];
          } catch (addonError) {
            this.log(LogLevel.WARN, 'Could not fetch addon information');
          }
        }
      } catch (supervisorError) {
        this.log(LogLevel.DEBUG, 'Supervisor not available - this is normal for Core installations');
      }
      
      this.log(LogLevel.DEBUG, 'Retrieved system information');
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(systemInfo, null, 2),
          },
        ],
      };
    } catch (error) {
      this.log(LogLevel.ERROR, 'Failed to get system info:', error);
      throw new McpError(ErrorCode.InternalError, 'Failed to retrieve system information');
    }
  }

  private async manageTodoLists(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.action) {
      throw new McpError(ErrorCode.InvalidParams, 'action is required');
    }
    
    try {
      switch (args.action) {
        case 'list':
          // Get all todo entities
          const statesResponse = await this.withRetry(() => 
            this.haClient.get('/api/states')
          );
          
          const todoLists = statesResponse.data
            .filter((entity: HomeAssistantEntity) => entity.entity_id.startsWith('todo.'))
            .map((todoList: HomeAssistantEntity) => {
              const listWithName = this.addFriendlyName(todoList);
              return {
                entity_id: listWithName.entity_id,
                friendly_name: listWithName.friendly_name,
                state: listWithName.state,
                supported_features: listWithName.attributes?.supported_features,
                last_updated: listWithName.last_updated,
              };
            });
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  todo_lists: todoLists,
                  total_count: todoLists.length,
                }, null, 2),
              },
            ],
          };
          
        case 'get_items':
          if (!args.entity_id) {
            throw new McpError(ErrorCode.InvalidParams, 'entity_id is required for get_items');
          }
          
          const sanitizedEntityId = this.sanitizeInput(args.entity_id);
          if (!this.validateEntityId(sanitizedEntityId) || !sanitizedEntityId.startsWith('todo.')) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid todo list entity_id format');
          }
          
          // Try multiple approaches to get todo items
          let items = [];
          let itemsFound = false;
          
          try {
            // Method 1: Direct API endpoint (preferred)
            const listId = sanitizedEntityId.replace('todo.', '');
            const itemsResponse = await this.withRetry(() => 
              this.haClient.get(`/api/todo/${listId}/items`)
            );
            items = itemsResponse.data || [];
            itemsFound = true;
          } catch (error) {
            this.log(LogLevel.DEBUG, `Direct API failed for ${sanitizedEntityId}, trying service call`);
            
            try {
              // Method 2: Service call approach
              const serviceResponse = await this.withRetry(() => 
                this.haClient.post('/api/services/todo/get_items', {
                  entity_id: sanitizedEntityId,
                })
              );
              
              // Service calls return different structure
              if (serviceResponse.data && Array.isArray(serviceResponse.data)) {
                items = serviceResponse.data[0]?.items || [];
              } else {
                items = serviceResponse.data?.items || [];
              }
              itemsFound = true;
            } catch (serviceError) {
              this.log(LogLevel.ERROR, `Both methods failed for getting todo items from ${sanitizedEntityId}`);
              throw new McpError(ErrorCode.InternalError, `Failed to retrieve todo items: ${serviceError}`);
            }
          }
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  entity_id: sanitizedEntityId,
                  items: items.map((item: any) => ({
                    uid: item.uid,
                    summary: item.summary,
                    description: item.description,
                    status: item.status,
                    due: item.due,
                    created: item.created,
                    modified: item.modified,
                  })),
                  total_items: items.length,
                }, null, 2),
              },
            ],
          };
          
        case 'add_item':
          if (!args.entity_id || !args.item) {
            throw new McpError(ErrorCode.InvalidParams, 'entity_id and item are required for add_item');
          }
          
          const addEntityId = this.sanitizeInput(args.entity_id);
          if (!this.validateEntityId(addEntityId) || !addEntityId.startsWith('todo.')) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid todo list entity_id format');
          }
          
          const addData: any = {
            entity_id: addEntityId,
            item: args.item,
          };
          
          if (args.summary) {
            addData.summary = args.summary;
          }
          
          if (args.description) {
            addData.description = args.description;
          }
          
          if (args.due_date) {
            addData.due_date = args.due_date;
          }
          
          await this.withRetry(() => 
            this.haClient.post('/api/services/todo/add_item', addData)
          );
          
          this.log(LogLevel.INFO, `Added item to ${addEntityId}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_added: true,
                  entity_id: addEntityId,
                  item: args.item,
                }, null, 2),
              },
            ],
          };
          
        case 'update_item':
          if (!args.entity_id || !args.item_id) {
            throw new McpError(ErrorCode.InvalidParams, 'entity_id and item_id are required for update_item');
          }
          
          const updateEntityId = this.sanitizeInput(args.entity_id);
          if (!this.validateEntityId(updateEntityId) || !updateEntityId.startsWith('todo.')) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid todo list entity_id format');
          }
          
          const updateData: any = {
            entity_id: updateEntityId,
          };
          
          // Try both uid and item parameters for compatibility
          if (args.item_id) {
            updateData.uid = args.item_id;
            updateData.item = args.item_id; // Fallback for older versions
          }
          
          if (args.summary) {
            updateData.summary = args.summary;
          }
          
          if (args.description) {
            updateData.description = args.description;
          }
          
          if (args.status) {
            updateData.status = args.status;
          }
          
          if (args.due_date) {
            updateData.due_date = args.due_date;
          }
          
          try {
            await this.withRetry(() => 
              this.haClient.post('/api/services/todo/update_item', updateData)
            );
          } catch (error) {
            this.log(LogLevel.ERROR, `Failed to update todo item:`, { updateData, error });
            throw new McpError(ErrorCode.InternalError, `Todo list operation failed: ${error}`);
          }
          
          this.log(LogLevel.INFO, `Updated item ${args.item_id} in ${updateEntityId}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_updated: true,
                  entity_id: updateEntityId,
                  item_id: args.item_id,
                }, null, 2),
              },
            ],
          };
          
        case 'remove_item':
          if (!args.entity_id || !args.item_id) {
            throw new McpError(ErrorCode.InvalidParams, 'entity_id and item_id are required for remove_item');
          }
          
          const removeEntityId = this.sanitizeInput(args.entity_id);
          if (!this.validateEntityId(removeEntityId) || !removeEntityId.startsWith('todo.')) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid todo list entity_id format');
          }
          
          // Try multiple parameter formats for compatibility
          const removeData: any = {
            entity_id: removeEntityId,
          };
          
          if (args.item_id) {
            removeData.uid = args.item_id;
            removeData.item = args.item_id; // Fallback for older versions
          }
          
          try {
            await this.withRetry(() => 
              this.haClient.post('/api/services/todo/remove_item', removeData)
            );
          } catch (error) {
            this.log(LogLevel.ERROR, `Failed to remove todo item:`, { removeData, error });
            throw new McpError(ErrorCode.InternalError, `Todo list operation failed: ${error}`);
          }
          
          this.log(LogLevel.INFO, `Removed item ${args.item_id} from ${removeEntityId}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_removed: true,
                  entity_id: removeEntityId,
                  item_id: args.item_id,
                }, null, 2),
              },
            ],
          };
          
        case 'create_list_info':
          if (!args.list_name) {
            throw new McpError(ErrorCode.InvalidParams, 'list_name is required for create_list');
          }
          
          // Note: Creating new todo lists typically requires integration-specific configuration
          // This is a generic approach that may work with some integrations
          const listName = this.sanitizeInput(args.list_name);
          
          // Validate list name format
          if (!/^[a-zA-Z0-9_\s\-]+$/.test(listName)) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid list name format. Use only letters, numbers, spaces, hyphens, and underscores.');
          }
          
          // Based on research: Home Assistant does not support programmatic todo list creation
          // This is a known platform limitation, not an MCP server issue
          this.log(LogLevel.INFO, `Create list requested for: ${listName} - providing guidance`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  list_created: false,
                  list_name: listName,
                  error: 'Home Assistant platform limitation',
                  explanation: 'Home Assistant does not provide any service or API to create new todo list entities programmatically. This is a known limitation in the platform.',
                  manual_steps: [
                    '1. Go to Settings > Devices & Services in Home Assistant',
                    '2. Add the "Local to-do" integration if not already added',
                    '3. Create your todo list through the integration interface',
                    '4. Once created, use this MCP server to fully manage items in the list'
                  ],
                  available_actions: [
                    'Use manage_todo_lists with action "list" to see existing lists',
                    'Use manage_todo_lists with action "add_item" to add items to existing lists',
                    'Use manage_shopping_list for the built-in shopping list',
                  ],
                  references: [
                    'GitHub Issue #108697: Unable to create Local Todo list entities via YAML',
                    'Home Assistant docs: Local to-do integration does not support YAML setup',
                  ],
                }, null, 2),
              },
            ],
          };
          
        case 'create_list_ws':
          if (!args.list_name) {
            throw new McpError(ErrorCode.InvalidParams, 'list_name is required for create_list_ws');
          }
          
          const wsListName = this.sanitizeInput(args.list_name);
          
          // Validate list name format
          if (!/^[a-zA-Z0-9_\s\-]+$/.test(wsListName)) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid list name format. Use only letters, numbers, spaces, hyphens, and underscores.');
          }
          
          return await this.createTodoListViaWebSocket(wsListName);
          
        default:
          throw new McpError(ErrorCode.InvalidParams, `Invalid action: ${args.action}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new McpError(ErrorCode.InvalidParams, 'Todo list not found or todo integration not available');
        } else if (status === 400) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid todo operation: ${error.response?.data?.message || 'Bad request'}`);
        }
      }
      
      this.log(LogLevel.ERROR, 'Todo list operation failed:', error);
      throw new McpError(ErrorCode.InternalError, 'Todo list operation failed');
    }
  }

  /**
   * Helper function to find shopping list item by name
   */
  private async findShoppingListItemByName(itemName: string, listEntityId: string = 'todo.shopping_list'): Promise<any | null> {
    try {
      // Try multiple approaches for finding items
      let items = [];
      let foundItem = null;
      
      try {
        // First try the todo service approach
        this.log(LogLevel.DEBUG, 'Trying todo.get_items service for item lookup');
        const response = await this.withRetry(() => 
          this.haClient.post('/api/services/todo/get_items', {
            entity_id: listEntityId,
          })
        );
        items = response.data || [];
        this.log(LogLevel.DEBUG, `Found ${items.length} items in shopping list`, items);
        foundItem = items.find((item: any) => 
          item.summary && item.summary.toLowerCase() === itemName.toLowerCase()
        );
        
        // Map uid to id for compatibility
        if (foundItem) {
          foundItem.id = foundItem.uid;
          this.log(LogLevel.DEBUG, `Found matching item:`, foundItem);
        }
      } catch (error) {
        this.log(LogLevel.DEBUG, 'Todo service failed, trying direct API approach:', error);
        // Fallback to direct API call
        try {
          const response = await this.withRetry(() => 
            this.haClient.get('/api/shopping_list')
          );
          items = response.data || [];
          foundItem = items.find((item: any) => 
            item.name && item.name.toLowerCase() === itemName.toLowerCase()
          );
        } catch (apiError) {
          this.log(LogLevel.DEBUG, 'Direct API also failed:', apiError);
          // Try todo entity state
          const stateResponse = await this.withRetry(() => 
            this.haClient.get(`/api/states/${listEntityId}`)
          );
          items = stateResponse.data?.attributes?.items || [];
          foundItem = items.find((item: any) => 
            item.summary && item.summary.toLowerCase() === itemName.toLowerCase()
          );
          
          // Map uid to id for compatibility
          if (foundItem) {
            foundItem.id = foundItem.uid;
          }
        }
      }
      
      return foundItem || null;
    } catch (error) {
      this.log(LogLevel.ERROR, 'Failed to fetch shopping list for item lookup:', error);
      return null;
    }
  }

  private async manageShoppingList(args: any) {
    if (!this.checkRateLimit()) {
      throw new McpError(ErrorCode.InternalError, 'Rate limit exceeded');
    }
    
    if (!args.action) {
      throw new McpError(ErrorCode.InvalidParams, 'action is required');
    }
    
    // Use provided list_id or default to shopping_list
    const listEntityId = args.list_id || 'todo.shopping_list';
    this.log(LogLevel.DEBUG, `Using todo list: ${listEntityId}`);
    
    try {
      switch (args.action) {
        case 'get':
          // Try multiple approaches for getting todo items
          let items = [];
          try {
            // First try the service approach
            const getResponse = await this.withRetry(() => 
              this.haClient.post('/api/services/todo/get_items', {
                entity_id: listEntityId,
              })
            );
            items = getResponse.data || [];
          } catch (error) {
            this.log(LogLevel.DEBUG, 'Service call failed, trying direct API approach:', error);
            // Fallback to direct API call
            try {
              const apiResponse = await this.withRetry(() => 
                this.haClient.get('/api/shopping_list')
              );
              items = (apiResponse.data || []).map((item: any) => ({
                uid: item.id,
                summary: item.name,
                status: item.complete ? 'completed' : 'needs_action'
              }));
            } catch (apiError) {
              this.log(LogLevel.DEBUG, 'Direct API also failed:', apiError);
              // Try todo entity state
              const stateResponse = await this.withRetry(() => 
                this.haClient.get(`/api/states/${listEntityId}`)
              );
              items = stateResponse.data?.attributes?.items || [];
            }
          }
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  shopping_list: items.map((item: any) => ({
                    id: item.uid,
                    name: item.summary,
                    complete: item.status === 'completed',
                  })),
                  total_items: items.length,
                  incomplete_items: items.filter((item: any) => item.status !== 'completed').length,
                }, null, 2),
              },
            ],
          };
          
        case 'add':
          if (!args.item) {
            throw new McpError(ErrorCode.InvalidParams, 'item is required for add action');
          }
          
          this.log(LogLevel.DEBUG, `Adding item to shopping list: ${args.item}`);
          
          // Try multiple approaches for adding items
          let addResponse;
          try {
            // First try the todo service approach
            addResponse = await this.withRetry(() => 
              this.haClient.post('/api/services/todo/add_item', {
                entity_id: listEntityId,
                item: args.item,
              })
            );
          } catch (error) {
            this.log(LogLevel.DEBUG, 'Todo service failed, trying direct API approach:', error);
            // Fallback to direct API call
            addResponse = await this.withRetry(() => 
              this.haClient.post('/api/shopping_list/item', {
                name: args.item,
              })
            );
          }
          
          this.log(LogLevel.INFO, `Added item to shopping list: ${args.item}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_added: true,
                  item: args.item,
                  id: addResponse.data?.id,
                }, null, 2),
              },
            ],
          };
          
        case 'update':
          this.log(LogLevel.DEBUG, 'Shopping list update called with args:', args);
          
          // Handle both item_id and id parameters for compatibility
          let itemId = args.item_id || args.id;
          
          // If no ID provided, try to find item by name
          if (!itemId && args.item) {
            this.log(LogLevel.DEBUG, `No item_id provided, searching for item by name: ${args.item}`);
            const foundItem = await this.findShoppingListItemByName(args.item, listEntityId);
            if (foundItem) {
              itemId = foundItem.id;
              this.log(LogLevel.DEBUG, `Found item by name, using ID: ${itemId}`);
            }
          }
          
          if (!itemId) {
            throw new McpError(ErrorCode.InvalidParams, 'item_id (or id) is required for update action, or provide item name to search. Available args: ' + JSON.stringify(Object.keys(args)));
          }
          
          // Try multiple approaches for updating items
          try {
            // First try the todo service approach
            const updateData: any = {
              entity_id: listEntityId,
              uid: itemId,
            };
            
            if (args.item) {
              updateData.rename = args.item;
            }
            
            if (args.complete !== undefined) {
              updateData.status = args.complete ? 'completed' : 'needs_action';
            }
            
            await this.withRetry(() => 
              this.haClient.post('/api/services/todo/update_item', updateData)
            );
          } catch (error) {
            this.log(LogLevel.DEBUG, 'Todo service failed, trying direct API approach:', error);
            // Fallback to direct API call
            const updateData: any = {};
            
            if (args.item) {
              updateData.name = args.item;
            }
            
            if (args.complete !== undefined) {
              updateData.complete = args.complete;
            }
            
            await this.withRetry(() => 
              this.haClient.post(`/api/shopping_list/item/${itemId}`, updateData)
            );
          }
          
          this.log(LogLevel.INFO, `Updated shopping list item ${itemId}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_updated: true,
                  item_id: itemId,
                }, null, 2),
              },
            ],
          };
          
        case 'remove':
          this.log(LogLevel.DEBUG, 'Shopping list remove called with args:', args);
          
          // For remove operation, we need either item name or item_id
          if (!args.item && !args.item_id && !args.id) {
            throw new McpError(ErrorCode.InvalidParams, 'Either item (name) or item_id is required for remove action. Available args: ' + JSON.stringify(Object.keys(args)));
          }
          
          // Try multiple approaches for removing items
          this.log(LogLevel.DEBUG, `Attempting to remove item: ${args.item || args.item_id || args.id}`);
          try {
            // First try the todo service approach using item name (preferred)
            if (args.item) {
              this.log(LogLevel.DEBUG, 'Trying todo.remove_item service with item name');
              await this.withRetry(() => 
                this.haClient.post('/api/services/todo/remove_item', {
                  entity_id: listEntityId,
                  item: args.item, // Use the item name directly
                })
              );
              this.log(LogLevel.DEBUG, 'Todo service with item name succeeded');
            } else {
              // If only ID provided, try to find the item first and use its name
              const itemId = args.item_id || args.id;
              this.log(LogLevel.DEBUG, `Looking up item by ID: ${itemId}`);
              const foundItem = await this.findShoppingListItemByName('', listEntityId); // We'll need to search all items
              // For now, try with the ID directly
              this.log(LogLevel.DEBUG, 'Trying todo.remove_item service with UID');
              await this.withRetry(() => 
                this.haClient.post('/api/services/todo/remove_item', {
                  entity_id: listEntityId,
                  item: itemId, // Use the UID
                })
              );
              this.log(LogLevel.DEBUG, 'Todo service with UID succeeded');
            }
          } catch (error) {
            this.log(LogLevel.DEBUG, 'Todo service failed, trying direct API approach:', error);
            // Fallback to direct API call
            const removeItemId = args.item_id || args.id;
            if (removeItemId) {
              await this.withRetry(() => 
                this.haClient.delete(`/api/shopping_list/item/${removeItemId}`)
              );
              this.log(LogLevel.DEBUG, 'Direct API succeeded');
            } else {
              throw new McpError(ErrorCode.InvalidParams, 'Cannot remove item: no valid ID found and todo service failed');
            }
          }
          
          this.log(LogLevel.INFO, `Removed shopping list item ${args.item || args.item_id || args.id}`);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  item_removed: true,
                  item: args.item || args.item_id || args.id,
                }, null, 2),
              },
            ],
          };
          
        case 'clear':
          const clearResponse = await this.withRetry(() => 
            this.haClient.post('/api/shopping_list/clear_completed')
          );
          
          this.log(LogLevel.INFO, 'Cleared completed shopping list items');
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  completed_items_cleared: true,
                }, null, 2),
              },
            ],
          };
          
        default:
          throw new McpError(ErrorCode.InvalidParams, `Invalid action: ${args.action}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new McpError(ErrorCode.InvalidParams, 'Shopping list item not found or shopping list integration not available');
        } else if (status === 400) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid shopping list operation: ${error.response?.data?.message || 'Bad request'}`);
        }
      }
      
      this.log(LogLevel.ERROR, 'Shopping list operation failed:', error);
      throw new McpError(ErrorCode.InternalError, 'Shopping list operation failed');
    }
  }

  private async createTodoListViaWebSocket(listName: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const wsUrl = config.haUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/api/websocket';
      const ws = new WebSocket(wsUrl);
      
      let messageId = 1;
      let authenticated = false;
      
      const sendMessage = (message: any) => {
        ws.send(JSON.stringify(message));
      };
      
      const cleanup = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };
      
      ws.on('open', () => {
        this.log(LogLevel.DEBUG, 'WebSocket connection opened');
      });
      
      ws.on('message', (data: string) => {
        try {
          const message = JSON.parse(data.toString());
          this.log(LogLevel.DEBUG, 'WebSocket message received:', message);
          
          if (message.type === 'auth_required') {
            // Send authentication
            sendMessage({
              type: 'auth',
              access_token: config.haToken
            });
          } else if (message.type === 'auth_ok') {
            authenticated = true;
            this.log(LogLevel.DEBUG, 'WebSocket authenticated successfully');
            
            // Try to create a new local_todo config entry
            sendMessage({
              id: messageId++,
              type: 'config_entries/flow/init',
              handler: 'local_todo'
            });
          } else if (message.type === 'auth_invalid') {
            cleanup();
            reject(new McpError(ErrorCode.InternalError, 'WebSocket authentication failed'));
          } else if (message.type === 'result') {
            if (message.success) {
              if (message.result && message.result.flow_id) {
                // Config flow started, now try to create with the list name
                sendMessage({
                  id: messageId++,
                  type: 'config_entries/flow/configure',
                  flow_id: message.result.flow_id,
                  user_input: {
                    name: listName
                  }
                });
              } else if (message.result && message.result.title) {
                // Successfully created
                cleanup();
                resolve({
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        list_created: true,
                        list_name: listName,
                        method: 'websocket',
                        result: message.result,
                        message: 'Successfully created todo list via WebSocket config flow'
                      }, null, 2),
                    },
                  ],
                });
              } else {
                // Unexpected result format
                cleanup();
                resolve({
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        list_created: false,
                        list_name: listName,
                        method: 'websocket',
                        error: 'Unexpected response format',
                        result: message.result,
                        message: 'WebSocket config flow returned unexpected format'
                      }, null, 2),
                    },
                  ],
                });
              }
            } else {
              // Config flow failed
              cleanup();
              resolve({
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      list_created: false,
                      list_name: listName,
                      method: 'websocket',
                      error: 'Config flow failed',
                      result: message.result,
                      message: 'Local todo config flow does not support programmatic creation or requires different parameters'
                    }, null, 2),
                  },
                ],
              });
            }
          } else {
            this.log(LogLevel.DEBUG, 'Other WebSocket message:', message);
          }
        } catch (error) {
          this.log(LogLevel.ERROR, 'WebSocket message parsing error:', error);
        }
      });
      
      ws.on('error', (error) => {
        this.log(LogLevel.ERROR, 'WebSocket error:', error);
        cleanup();
        reject(new McpError(ErrorCode.InternalError, `WebSocket error: ${error.message}`));
      });
      
      ws.on('close', () => {
        this.log(LogLevel.DEBUG, 'WebSocket connection closed');
        if (!authenticated) {
          reject(new McpError(ErrorCode.InternalError, 'WebSocket connection closed before authentication'));
        }
      });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        cleanup();
        reject(new McpError(ErrorCode.InternalError, 'WebSocket operation timed out'));
      }, 30000);
    });
  }

  async run() {
    // Perform initial health check
    if (!(await this.healthCheck())) {
      throw new Error('Initial health check failed. Please verify Home Assistant connection.');
    }
    
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.log(LogLevel.INFO, 'Home Assistant MCP server running on stdio');
  }
}

const server = new HomeAssistantServer(enabledTools);
server.run().catch(console.error);
