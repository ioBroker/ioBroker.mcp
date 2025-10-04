import ChannelDetector from '@iobroker/type-detector';
import type { McpAdapter } from './types';

interface DeviceState {
    id: string;
    role: string;
    type: string;
    unit?: string;
    value?: any;
    ack?: boolean;
    ts?: number;
    lc?: number;
}

interface Device {
    id: string;
    name: string;
    room?: string;
    type: string;
    vendor?: string;
    model?: string;
    roles: string[];
    states: DeviceState[];
    tags: string[];
}

function getName(name: ioBroker.StringOrTranslated | undefined, lang: string, id: string): string {
    if (!name) {
        return id;
    }
    if (typeof name === 'string') {
        return name;
    }
    return name[lang as ioBroker.Languages] || name.en || name.de || id;
}

function parentOf(id: string): string {
    const parts = (id || '').split('.');
    parts.pop();
    return parts.join('.');
}

async function allObjects(adapter: McpAdapter): Promise<Record<string, ioBroker.Object>> {
    const states = await adapter.getObjectViewAsync('system', 'state', {});
    const channels = await adapter.getObjectViewAsync('system', 'channel', {});
    const devices = await adapter.getObjectViewAsync('system', 'device', {});
    const enums = await adapter.getObjectViewAsync('system', 'enum', {});

    return (states.rows as { id: string; value: ioBroker.Object }[])
        .concat(channels.rows)
        .concat(devices.rows)
        .concat(enums.rows)
        .reduce(
            (obj, item) => {
                obj[item.id] = item.value;
                return obj;
            },
            {} as Record<string, ioBroker.Object>,
        );
}

export async function listDevices(
    adapter: McpAdapter,
    params: { room?: string; limit?: number; offset?: number },
): Promise<{ total: number; devices: Device[] }> {
    const { room, limit = 100, offset = 0 } = params;
    const lang = 'en';

    // Get all objects
    const objects = await allObjects(adapter);
    const keys = Object.keys(objects);

    // Get room enums if room filter is specified
    let roomMembers: string[] = [];
    if (room) {
        const enums = await adapter.getObjectViewAsync('system', 'enum', {});
        for (const row of enums.rows) {
            const enumObj = row.value;
            if (
                enumObj._id?.startsWith('enum.rooms.') &&
                enumObj?.common?.name &&
                (typeof enumObj.common.name === 'string'
                    ? enumObj.common.name.toLowerCase() === room.toLowerCase()
                    : Object.values(enumObj.common.name).some(
                          (n: any) => typeof n === 'string' && n.toLowerCase() === room.toLowerCase(),
                      ))
            ) {
                roomMembers = enumObj.common?.members || [];
                break;
            }
        }
    }

    // Build devices map
    const devicesMap = new Map<string, Device>();
    const detector = new ChannelDetector();

    // Process each device/channel in the objects
    for (const id of keys) {
        const obj = objects[id];
        if (!obj || (obj.type !== 'device' && obj.type !== 'channel')) {
            continue;
        }

        // Apply room filter
        if (room) {
            const deviceInRoom = roomMembers.some(
                member =>
                    member === id ||
                    member.startsWith(`${id}.`) ||
                    id.startsWith(`${member}.`) ||
                    member.startsWith(`${parentOf(id)}.`),
            );
            if (!deviceInRoom) {
                continue;
            }
        }

        // Try to detect device type
        const options = {
            objects,
            id,
            _keysOptional: keys,
            _usedIdsOptional: [],
        };

        const controls = detector.detect(options);
        let deviceType = 'unknown';
        const detectedStates: string[] = [];

        if (controls && controls.length > 0) {
            deviceType = controls[0].type;
            // Collect all state IDs from detected controls
            for (const control of controls) {
                for (const state of control.states) {
                    if (state.id && !detectedStates.includes(state.id)) {
                        detectedStates.push(state.id);
                    }
                }
            }
        }

        // Get device name
        const deviceName = getName(obj.common?.name, lang, id);

        // Get room for this device
        let deviceRoom: string | undefined;
        const enums = await adapter.getObjectViewAsync('system', 'enum', {});
        for (const row of enums.rows) {
            const enumObj = row.value;
            if (enumObj._id?.startsWith('enum.rooms.') && enumObj.common?.members) {
                const inRoom = enumObj.common.members.some(
                    member => member === id || member.startsWith(`${id}.`) || id.startsWith(`${member}.`),
                );
                if (inRoom) {
                    deviceRoom = getName(enumObj.common.name, lang, enumObj._id);
                    break;
                }
            }
        }

        // Extract adapter name and tags
        const adapterMatch = id.match(/^([^.]+)\./);
        const adapterName = adapterMatch ? adapterMatch[1] : '';
        const tags: string[] = [];
        if (adapterName) {
            tags.push(adapterName);
        }

        // Get all states under this device/channel
        const deviceStates: DeviceState[] = [];
        const roles: string[] = [];

        for (const stateId of keys) {
            if (stateId.startsWith(`${id}.`) || stateId === id) {
                const stateObj = objects[stateId];
                if (stateObj && stateObj.type === 'state') {
                    // Get current state value
                    const stateValue = await adapter.getForeignStateAsync(stateId);

                    const deviceState: DeviceState = {
                        id: stateId,
                        role: stateObj.common?.role || '',
                        type: (stateObj.common?.type as string) || 'mixed',
                        unit: stateObj.common?.unit,
                        value: stateValue?.val,
                        ack: stateValue?.ack,
                        ts: stateValue?.ts,
                    };

                    if (stateValue && stateValue.lc !== stateValue.ts) {
                        deviceState.lc = stateValue.lc;
                    }

                    deviceStates.push(deviceState);

                    // Add role to roles list if not already present
                    if (deviceState.role && !roles.includes(deviceState.role)) {
                        roles.push(deviceState.role);
                    }
                }
            }
        }

        // Only add devices that have states
        if (deviceStates.length > 0) {
            const device: Device = {
                id: `device:${id}`,
                name: deviceName,
                room: deviceRoom,
                type: deviceType,
                vendor: obj.common?.['vendor' as keyof typeof obj.common] as string | undefined,
                model: obj.common?.['model' as keyof typeof obj.common] as string | undefined,
                roles,
                states: deviceStates,
                tags,
            };
            devicesMap.set(id, device);
        }
    }

    // Convert map to array and apply pagination
    const allDevices = Array.from(devicesMap.values());
    const total = allDevices.length;
    const paginatedDevices = allDevices.slice(offset, offset + limit);

    return {
        total,
        devices: paginatedDevices,
    };
}
