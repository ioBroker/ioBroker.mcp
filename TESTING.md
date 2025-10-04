# Testing the list_devices Method

## Manual Testing

To test the `list_devices` method, you can use curl or any HTTP client to send a POST request to the MCP server.

### Prerequisites
1. Install and start the MCP adapter in your ioBroker instance
2. Ensure the server is running on the configured port (default: 8093)

### Test Request

```bash
curl -X POST http://localhost:8093/api/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "list_devices",
    "params": {
      "room": "Livingroom",
      "limit": 100,
      "offset": 0
    }
  }'
```

### Expected Response Format

```json
{
  "ok": true,
  "data": {
    "total": 2,
    "devices": [
      {
        "id": "device:zigbee.0.0x00158d0001a2b3c4",
        "name": "Livingroom Thermometer",
        "room": "Livingroom",
        "type": "temperature",
        "vendor": "Xiaomi",
        "model": "LYWSD03MMC",
        "roles": ["value.temperature", "value.humidity", "value.battery"],
        "states": [
          {
            "id": "zigbee.0.0x00158d0001a2b3c4.temperature",
            "role": "value.temperature",
            "type": "number",
            "unit": "°C",
            "value": 22.6,
            "ack": true,
            "ts": 1727950245123,
            "lc": 1727949244000
          },
          {
            "id": "zigbee.0.0x00158d0001a2b3c4.humidity",
            "role": "value.humidity",
            "type": "number",
            "unit": "%",
            "value": 48.1,
            "ack": true,
            "ts": 1727950245123,
            "lc": 1727949244000
          },
          {
            "id": "zigbee.0.0x00158d0001a2b3c4.battery",
            "role": "value.battery",
            "type": "number",
            "unit": "%",
            "value": 82,
            "ack": true
          }
        ],
        "tags": ["zigbee"]
      }
    ]
  }
}
```

### Test Cases

1. **List all devices without filters**
   ```json
   {
     "method": "list_devices",
     "params": {}
   }
   ```

2. **List devices in a specific room**
   ```json
   {
     "method": "list_devices",
     "params": {
       "room": "Livingroom"
     }
   }
   ```

3. **List devices with pagination**
   ```json
   {
     "method": "list_devices",
     "params": {
       "limit": 10,
       "offset": 0
     }
   }
   ```

4. **List devices in a specific room with pagination**
   ```json
   {
     "method": "list_devices",
     "params": {
       "room": "Bedroom",
       "limit": 5,
       "offset": 0
     }
   }
   ```

### Implementation Details

The `list_devices` method uses the `@iobroker/type-detector` library to automatically detect device types based on their states and roles. The implementation:

1. Fetches all ioBroker objects (states, channels, devices, enums)
2. Uses the ChannelDetector to identify device types
3. Filters devices by room if specified
4. Collects all states for each device
5. Returns paginated results with device metadata

### Key Features

- **Automatic device type detection**: Uses the type-detector library to identify device types (temperature, thermostat, light, etc.)
- **Room filtering**: Filter devices by room name (case-insensitive)
- **Pagination**: Support for limit and offset parameters
- **State values**: Includes current state values, timestamps, and acknowledgment status
- **Device metadata**: Includes vendor, model, and adapter information when available
