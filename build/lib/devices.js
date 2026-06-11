"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidSmartName = isValidSmartName;
exports.controls = controls;
exports.getAiFriendlyStructure = getAiFriendlyStructure;
/**
 * Device detection utilities, ported from the ioBroker n8n nodes
 * (`IoBrokerNodes/DevicesUtils.ts`).
 *
 * Uses the ioBroker type detector (https://github.com/ioBroker/ioBroker.type-detector)
 * to turn raw states/channels/devices into "controls" (functional devices) and groups
 * them into an AI-friendly structure of rooms -> devices -> named controls.
 *
 * All object reads accept an optional `{ user }` so the detection respects the ACLs of
 * the configured default user (see McpServer).
 */
const type_detector_1 = __importStar(require("@iobroker/type-detector"));
/**
 * Checks whether the provided value is a valid smart name.
 *
 * @param smartName The value to check
 * @param lang Configured language
 * @returns True if a valid smart name, false - otherwise.
 */
function isValidSmartName(smartName, lang) {
    let name = smartName;
    if (smartName === false || smartName === 'ignore') {
        return false;
    }
    if (smartName && typeof smartName === 'object') {
        name = smartName[lang] || smartName.en || smartName.de;
    }
    return ![null, undefined, 'ignore', false].includes(name);
}
function isRoom(enumObject) {
    return enumObject?._id?.startsWith('enum.rooms.');
}
function isFunctionality(enumObject) {
    return enumObject?._id?.startsWith('enum.functions.');
}
async function allEnums(adapter, options) {
    const result = await adapter.getObjectViewAsync('system', 'enum', {}, options);
    return result.rows.map(row => row.value);
}
function parentOf(id) {
    const parts = (id || '').split('.');
    parts.pop();
    return parts.join('.');
}
async function allObjects(adapter, options) {
    const states = await adapter.getObjectViewAsync('system', 'state', {}, options);
    const channels = await adapter.getObjectViewAsync('system', 'channel', {}, options);
    const devices = await adapter.getObjectViewAsync('system', 'device', {}, options);
    const enums = await adapter.getObjectViewAsync('system', 'enum', {}, options);
    return states.rows
        .concat(channels.rows)
        .concat(devices.rows)
        .concat(enums.rows)
        .reduce((obj, item) => ((obj[item.id] = {
        common: item.value?.common,
        type: item.value?.type,
    }),
        obj), {});
}
function getSmartNameFromObj(obj, instanceId, noCommon) {
    if (!obj) {
        return undefined;
    }
    let result;
    // If it is a common object
    if (!obj.common) {
        result = obj.smartName;
    }
    else if (!noCommon) {
        result = obj.common.smartName;
    }
    else {
        const custom = obj.common.custom;
        if (!custom) {
            return undefined;
        }
        result = custom[instanceId] ? custom[instanceId].smartName : undefined;
    }
    if (result && typeof result === 'string') {
        if (result === 'ignore') {
            return false;
        }
        return {
            en: result,
        };
    }
    return result;
}
async function functionalitiesAndRooms(adapter, options) {
    const enumerations = await allEnums(adapter, options);
    // skip empty enums (with no members, i.e. states, assigned)
    const notEmptyRoomsAndFunctionalities = enumerations
        .filter(item => {
        const smartName = getSmartNameFromObj(item, adapter.namespace);
        return smartName !== false;
    })
        .filter(item => item?.common?.members?.length);
    // all enums that are of type 'function'
    const functionalities = notEmptyRoomsAndFunctionalities.filter(item => isFunctionality(item));
    // all enums, that are of type 'room'
    const rooms = notEmptyRoomsAndFunctionalities.filter(item => isRoom(item));
    return [functionalities, rooms];
}
function getChannelId(id, objects) {
    if (objects[id] && objects[id].type === 'channel') {
        return id;
    }
    if (objects[id] && objects[id].type === 'state') {
        const channelId = parentOf(id);
        if (objects[channelId] && objects[channelId].type === 'channel') {
            return channelId;
        }
    }
    return null;
}
function getDeviceId(id, objects) {
    const channelId = getChannelId(id, objects);
    if (channelId) {
        const deviceId = parentOf(channelId);
        if (objects[deviceId] && (objects[deviceId].type === 'device' || objects[deviceId].type === 'channel')) {
            return deviceId;
        }
    }
    return null;
}
/**
 * Inspects all objects (states, channels and devices) and tries to identify so-called 'controls'
 *
 * To identify the controls, the ioBroker type detector library is used (https://github.com/ioBroker/ioBroker.type-detector).
 *
 * @param adapter The adapter instance
 * @param lang language
 * @param options read options (ACL user)
 * @returns An array containing the detected controls
 */
async function controls(adapter, lang, options) {
    // here we collect ids to inspect
    const list = [];
    // fetch all objects (states, channels and devices in terms of iobroker)
    const devicesObject = await allObjects(adapter, options);
    // fetch all defined rooms and functions (enumerations)
    const [functionalities, rooms] = await functionalitiesAndRooms(adapter, options);
    // every member of a function enumeration is added to the list of ids to inspect
    functionalities.forEach(functionEnumItem => {
        functionEnumItem.common.members?.forEach(id => {
            const smartName = getSmartNameFromObj(devicesObject[id], adapter.namespace);
            const objType = devicesObject[id]?.type;
            if (devicesObject[id]?.common &&
                (objType === 'state' || objType === 'channel' || objType === 'device') &&
                !list.includes(id) &&
                smartName !== false // if the device is not disabled
            ) {
                list.push(id);
            }
        });
    });
    // a member of a room enumeration is only added if neither its parent (channel) nor its grandparent (device) is in
    rooms.forEach(roomEnumItem => {
        roomEnumItem.common.members?.forEach(id => {
            if (!devicesObject[id]) {
                return;
            }
            const smartName = getSmartNameFromObj(devicesObject[id], adapter.namespace);
            const objType = devicesObject[id].type;
            if (devicesObject[id]?.common &&
                (objType === 'state' || objType === 'channel' || objType === 'device') &&
                !list.includes(id) &&
                smartName !== false // if the device is not disabled
            ) {
                const channelId = getChannelId(id, devicesObject);
                if (channelId) {
                    if (!list.includes(channelId)) {
                        const deviceId = getDeviceId(id, devicesObject);
                        if (deviceId) {
                            if (!list.includes(deviceId)) {
                                list.push(id);
                            }
                        }
                        else {
                            list.push(id);
                        }
                    }
                }
                else {
                    list.push(id);
                }
            }
        });
    });
    // all ids, i.e. ids of all iobroker states/channels/devices
    const keys = Object.keys(devicesObject).sort();
    const idsWithSmartName = [];
    // if a state has got a smart name directly assigned and neither itself nor its channel is in the list, add its id to the inspection list
    // and process it first
    keys.forEach(id => {
        const smartName = devicesObject[id] && getSmartNameFromObj(devicesObject[id], adapter.namespace);
        const objType = devicesObject[id].type;
        if (isValidSmartName(smartName, lang) &&
            devicesObject[id].common &&
            (objType === 'state' || objType === 'channel' || objType === 'device')) {
            idsWithSmartName.push(id);
        }
    });
    // collect first all smart names and remove them from the auto-groups
    const detectedControls = [];
    const detector = new type_detector_1.default();
    const patterns = type_detector_1.default.getPatterns();
    // process states with defined smartName
    for (let s = 0; s < idsWithSmartName.length; s++) {
        const id = idsWithSmartName[s];
        const common = devicesObject[id].common;
        const smartName = getSmartNameFromObj(devicesObject[id], adapter.namespace);
        // try to convert the state to typeDetector format
        // "smartName": {
        //    "de": "Rote Lampe",
        //    "smartType": "LIGHT", // optional
        //    "byON": 80            // optional
        //  }
        if (!smartName.smartType) {
            // by default,
            // all booleans are sockets
            // all numbers are dimmer
            // string is not possible to control
            if (common.type === 'boolean' || common.type === 'mixed') {
                // we will write boolean
                smartName.smartType = 'socket';
            }
            else if (common.type === 'number') {
                smartName.smartType = 'dimmer';
            }
            else {
                smartName.smartType = 'socket';
            }
        }
        // try to simulate typeDetector format
        if (patterns[smartName.smartType]) {
            const control = JSON.parse(JSON.stringify(patterns[smartName.smartType]));
            // find first required
            const state = control.states.find(state => state.required);
            if (state) {
                state.id = id;
                // process control
                // remove all unassigned control register
                control.states = control.states.filter(s => s.id);
                // take all smartNames if any
                control.states.forEach(s => {
                    s.smartName = getSmartNameFromObj(devicesObject[s.id], adapter.namespace);
                    s.common = {
                        min: devicesObject[s.id]?.common?.min,
                        max: devicesObject[s.id]?.common?.max,
                        type: devicesObject[s.id]?.common?.type,
                        states: devicesObject[s.id]?.common?.states,
                        unit: devicesObject[s.id]?.common?.unit,
                        role: devicesObject[s.id]?.common?.role,
                        name: devicesObject[s.id]?.common?.name,
                        icon: devicesObject[s.id]?.common?.icon,
                        color: devicesObject[s.id]?.common?.color,
                    };
                });
                devicesObject[id].common.smartName = smartName;
                control.object = {
                    id,
                    type: devicesObject[id].type,
                    common: devicesObject[id].common,
                    autoDetected: false,
                    toggle: smartName?.toggle,
                };
                // remove id from the groups
                let pos = list.indexOf(id);
                if (pos !== -1) {
                    list.splice(pos, 1);
                }
                const channelId = getChannelId(id, devicesObject);
                if (channelId) {
                    pos = list.indexOf(channelId);
                    if (pos !== -1) {
                        list.splice(pos, 1);
                    }
                }
                const name = smartName[lang] || smartName.en || smartName.de;
                control.groupNames = name?.split(',').map(n => n.trim()) || [];
                detectedControls.push(control);
            }
        }
    }
    // initialize iobroker type detector
    const usedIds = [];
    const ignoreIndicators = ['UNREACH_STICKY']; // Ignore indicators by name
    const excludedTypes = [type_detector_1.Types.info];
    const detectOptions = {
        objects: devicesObject,
        _keysOptional: keys,
        _usedIdsOptional: usedIds,
        ignoreIndicators,
        excludedTypes,
        id: '', // this will be set for each id in the list
    };
    // go other the list of IDs to inspect and collect the detected controls
    list.forEach(id => {
        detectOptions.id = id;
        const detected = detector.detect(detectOptions);
        detected?.forEach(control => {
            const iotControl = control;
            // if any detected state has an ID, we can use this control
            if (iotControl.states.find(state => state.id)) {
                // remove all unassigned control register
                iotControl.states = iotControl.states.filter(s => s.id);
                // take all smartNames if any
                iotControl.states.forEach(s => {
                    s.smartName = getSmartNameFromObj(devicesObject[s.id], adapter.namespace);
                    s.common = {
                        min: devicesObject[s.id]?.common?.min,
                        max: devicesObject[s.id]?.common?.max,
                        type: devicesObject[s.id]?.common?.type,
                        states: devicesObject[s.id]?.common?.states,
                        unit: devicesObject[s.id]?.common?.unit,
                        role: devicesObject[s.id]?.common?.role,
                        name: devicesObject[s.id]?.common?.name,
                        icon: devicesObject[s.id]?.common?.icon,
                        color: devicesObject[s.id]?.common?.color,
                    };
                });
                // find out the room the found control is in
                const room = rooms.find(room => room?.common?.members?.includes(id));
                // find out the functionality the found control assigned to
                const functionality = functionalities.find(functionality => functionality?.common?.members?.includes(id));
                const smartName = getSmartNameFromObj(devicesObject[id], adapter.namespace);
                iotControl.object = {
                    id,
                    type: devicesObject[id].type,
                    common: {
                        min: devicesObject[id].common?.min,
                        max: devicesObject[id].common?.max,
                        type: devicesObject[id].common?.type,
                        states: devicesObject[id].common?.states,
                        role: devicesObject[id].common?.role,
                        name: devicesObject[id].common?.name,
                        icon: devicesObject[id].common?.icon,
                        color: devicesObject[id].common?.color,
                        smartName,
                    },
                    autoDetected: true,
                    toggle: smartName && typeof smartName === 'object' ? smartName.toggle : undefined,
                };
                iotControl.room = room
                    ? {
                        id: room._id,
                        common: room.common,
                    }
                    : undefined;
                iotControl.functionality = functionality
                    ? {
                        id: functionality._id,
                        common: functionality.common,
                    }
                    : undefined;
                detectedControls.push(iotControl);
            }
        });
    });
    return detectedControls;
}
function getName(name, lang, id) {
    if (typeof name === 'string') {
        return name;
    }
    if (name) {
        return name[lang] || name.en || Object.values(name)[0] || id.split('.').pop() || 'Unnamed';
    }
    return id?.split('.').pop() || 'Unnamed';
}
function getControlType(device, state) {
    let smartType;
    // Try to guess from Device Type
    if (device.type === type_detector_1.Types.airCondition) {
        if (state.name === 'SET') {
            // set temperature
            smartType = 'targetTemperature';
        }
        else if (state.name === 'ACTUAL') {
            smartType = 'actualTemperature';
        }
        else if (state.name === 'SPEED') {
            smartType = 'fanSpeed';
        }
        else if (state.name === 'POWER') {
            smartType = 'power';
        }
        else if (state.name === 'HUMIDITY') {
            smartType = 'humidity';
        }
        else if (state.name === 'BOOST') {
            smartType = 'boostMode';
        }
        else if (state.name === 'SWING') {
            if (state.common.type === 'boolean') {
                smartType = 'swingOnOff';
            }
            else if (state.common.type === 'number') {
                smartType = 'swingPosition';
            }
        }
    }
    else if (device.type === type_detector_1.Types.blind) {
        if (state.name === 'SET') {
            smartType = 'blindPosition';
        }
        else if (state.name === 'STOP') {
            smartType = 'stop';
        }
        else if (state.name === 'OPEN') {
            smartType = 'open';
        }
        else if (state.name === 'CLOSE') {
            smartType = 'close';
        }
    }
    else if (device.type === type_detector_1.Types.cie) {
        if (state.name === 'CIE') {
            // set temperature
            smartType = 'color';
        }
        else if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.ct) {
        if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.dimmer) {
        if (state.name === 'SET') {
            smartType = 'dimmer';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.door) {
        if (state.name === 'ACTUAL') {
            smartType = 'openedClosed';
        }
    }
    else if (device.type === type_detector_1.Types.fireAlarm) {
        if (state.name === 'ACTUAL') {
            smartType = 'alarm';
        }
    }
    else if (device.type === type_detector_1.Types.floodAlarm) {
        if (state.name === 'ACTUAL') {
            smartType = 'alarm';
        }
    }
    else if (device.type === type_detector_1.Types.gate) {
        if (state.name === 'SET') {
            smartType = 'openClose';
        }
        else if (state.name === 'STOP') {
            smartType = 'stop';
        }
    }
    else if (device.type === type_detector_1.Types.hue) {
        if (state.name === 'HUE') {
            smartType = 'color';
        }
        else if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'SATURATION') {
            smartType = 'saturation';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.humidity) {
        if (state.name === 'ACTUAL') {
            smartType = 'humidity';
        }
    }
    else if (device.type === type_detector_1.Types.illuminance) {
        if (state.name === 'ACTUAL') {
            smartType = 'illuminance';
        }
    }
    else if (device.type === type_detector_1.Types.slider) {
        if (state.name === 'SET') {
            smartType = 'level';
        }
    }
    else if (device.type === type_detector_1.Types.light) {
        if (state.name === 'SET') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.lock) {
        if (state.name === 'SET') {
            smartType = 'lock';
        }
        else if (state.name === 'OPEN') {
            smartType = 'open';
        }
    }
    else if (device.type === type_detector_1.Types.motion) {
        if (state.name === 'ACTUAL') {
            smartType = 'alarm';
        }
    }
    else if (device.type === type_detector_1.Types.rgb) {
        if (state.name === 'RED') {
            smartType = 'colorRed';
        }
        else if (state.name === 'BLUE') {
            smartType = 'colorBlue';
        }
        else if (state.name === 'GREEN') {
            smartType = 'colorGreen';
        }
        else if (state.name === 'WHITE') {
            smartType = 'colorWhite';
        }
        else if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.rgbSingle) {
        if (state.name === 'RGB') {
            smartType = 'color';
        }
        else if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.rgbwSingle) {
        if (state.name === 'RGBW') {
            smartType = 'color';
        }
        else if (state.name === 'DIMMER' || state.name === 'BRIGHTNESS') {
            smartType = 'dimmer';
        }
        else if (state.name === 'TEMPERATURE') {
            smartType = 'colorTemperature';
        }
        else if (state.name === 'ON') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.socket) {
        if (state.name === 'SET') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.temperature) {
        if (state.name === 'ACTUAL') {
            smartType = 'actualTemperature';
        }
    }
    else if (device.type === type_detector_1.Types.thermostat) {
        if (state.name === 'ACTUAL') {
            smartType = 'actualTemperature';
        }
        else if (state.name === 'SET') {
            smartType = 'targetTemperature';
        }
        else if (state.name === 'HUMIDITY') {
            smartType = 'humidity';
        }
        else if (state.name === 'BOOST') {
            smartType = 'boostMode';
        }
        else if (state.name === 'POWER') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.vacuumCleaner) {
        if (state.name === 'POWER') {
            smartType = 'power';
        }
    }
    else if (device.type === type_detector_1.Types.volume) {
        if (state.name === 'SET') {
            smartType = 'volume';
        }
    }
    else if (device.type === type_detector_1.Types.volumeGroup) {
        if (state.name === 'SET') {
            smartType = 'volume';
        }
    }
    else if (device.type === type_detector_1.Types.window) {
        if (state.name === 'ACTUAL') {
            smartType = 'openedClosed';
        }
    }
    else if (device.type === type_detector_1.Types.windowTilt) {
        if (state.name === 'ACTUAL') {
            smartType = 'openedClosed';
        }
    }
    return smartType || state.name;
}
/**
 * Build an AI-friendly structure of rooms -> devices -> named controls.
 *
 * @param adapter The adapter instance
 * @param lang language
 * @param options read options (ACL user)
 */
async function getAiFriendlyStructure(adapter, lang, options) {
    const devices = await controls(adapter, lang, options);
    // Reformat the data
    const rooms = [];
    devices.forEach(device => {
        let roomName;
        let roomObj;
        if (!device.room) {
            // Create "No room" object
            const rObj = rooms.find(r => r.roomName === 'No room');
            if (rObj) {
                roomObj = rObj;
            }
            else {
                roomObj = {
                    roomName: 'No room',
                    devicesInRoom: [],
                };
                rooms.push(roomObj);
            }
            roomName = 'No room';
        }
        else {
            roomName = getName(device.room.common.name, lang, device.room.id);
            const rObj = rooms.find(r => r.roomName === roomName);
            if (rObj) {
                roomObj = rObj;
            }
            else {
                roomObj = {
                    roomName,
                    devicesInRoom: [],
                };
                rooms.push(roomObj);
            }
        }
        const functionName = device.functionality
            ? getName(device.functionality.common.name, lang, device.functionality.id)
            : undefined;
        const dev = {
            deviceName: getName(device.object?.common?.name, lang, device.object?.id || ''),
            deviceType: device.type,
            friendlyDeviceNames: device.groupNames,
            controls: {},
        };
        if (roomName) {
            dev.room = roomName;
        }
        if (functionName) {
            dev.functionality = functionName;
        }
        // Fill controls
        device.states.forEach(state => {
            const control = {
                stateId: state.id,
                controlType: state.id === device.object?.id ? 'power' : state.role || 'power',
                role: state.defaultRole,
                writable: state.write !== false,
                readable: state.read !== false,
                unit: state.common?.unit || state.defaultUnit,
                min: typeof state.min === 'number' ? state.min : undefined,
                max: typeof state.max === 'number' ? state.max : undefined,
                ioBrokerValueType: state.common?.type || 'boolean',
            };
            let smartType = state.smartName?.smartType;
            if (!smartType) {
                // Try to guess from Device Type
                smartType = getControlType(device, state);
            }
            if (smartType) {
                dev.controls[smartType] = control;
            }
        });
        roomObj.devicesInRoom.push(dev);
    });
    return rooms;
}
//# sourceMappingURL=devices.js.map