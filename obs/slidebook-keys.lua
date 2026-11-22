obs = obslua
local ffi = require('ffi')

ffi.cdef[[
typedef uintptr_t SOCKET;
typedef struct { unsigned short family; unsigned short port; unsigned long addr; char zero[8]; } sockaddr_in;
int WSAStartup(unsigned short ver, void *data);
SOCKET socket(int af, int type, int protocol);
int connect(SOCKET s, const sockaddr_in *name, int len);
int send(SOCKET s, const char *buf, int len, int flags);
int recv(SOCKET s, char *buf, int len, int flags);
int setsockopt(SOCKET s, int level, int name, const char *val, int len);
int closesocket(SOCKET s);
unsigned short htons(unsigned short v);
unsigned long inet_addr(const char *cp);
]]
local ws = ffi.load('ws2_32')

local port = 8780
local hotkeys = {}
local ACTIONS = {
  { id = 'slidebook.next', label = 'SlideBook: Next slide', action = 'next', key = 'OBS_KEY_RIGHT' },
  { id = 'slidebook.prev', label = 'SlideBook: Previous slide', action = 'prev', key = 'OBS_KEY_LEFT' },
}

local wsa_ready = false
local function post(action)
  if not wsa_ready then
    ws.WSAStartup(0x0202, ffi.new('char[408]'))
    wsa_ready = true
  end
  local s = ws.socket(2, 1, 6)
  if s == ffi.cast('SOCKET', -1) then return end
  local timeout = ffi.new('int[1]', 500)
  ws.setsockopt(s, 0xffff, 0x1005, ffi.cast('const char*', timeout), 4)
  ws.setsockopt(s, 0xffff, 0x1006, ffi.cast('const char*', timeout), 4)
  local addr = ffi.new('sockaddr_in', { family = 2, port = ws.htons(port), addr = ws.inet_addr('127.0.0.1') })
  if ws.connect(s, addr, ffi.sizeof(addr)) == 0 then
    local body = '{"action":"' .. action .. '","target":"live"}'
    local req = 'POST /api/control HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
      .. 'Content-Length: ' .. #body .. '\r\nConnection: close\r\n\r\n' .. body
    ws.send(s, req, #req, 0)
    ws.recv(s, ffi.new('char[512]'), 512, 0)
  else
    obs.script_log(obs.LOG_WARNING, 'SlideBook is not running on 127.0.0.1:' .. port)
  end
  ws.closesocket(s)
end

function script_description()
  return 'Steps SlideBook from OBS hotkeys. Bind them in Settings > Hotkeys (default: Right = next, Left = previous).'
end

function script_properties()
  local p = obs.obs_properties_create()
  obs.obs_properties_add_int(p, 'port', 'SlideBook port', 1, 65535, 1)
  return p
end

function script_defaults(settings)
  obs.obs_data_set_default_int(settings, 'port', 8780)
end

function script_update(settings)
  port = obs.obs_data_get_int(settings, 'port')
end

function script_load(settings)
  for _, a in ipairs(ACTIONS) do
    local id = obs.obs_hotkey_register_frontend(a.id, a.label, function(pressed)
      if pressed then post(a.action) end
    end)
    hotkeys[a.id] = id
    local saved = obs.obs_data_get_array(settings, a.id)
    if obs.obs_data_array_count(saved) == 0 and not obs.obs_data_get_bool(settings, 'bound') then
      obs.obs_data_array_release(saved)
      saved = obs.obs_data_array_create()
      local k = obs.obs_data_create()
      obs.obs_data_set_string(k, 'key', a.key)
      obs.obs_data_array_push_back(saved, k)
      obs.obs_data_release(k)
    end
    obs.obs_hotkey_load(id, saved)
    obs.obs_data_array_release(saved)
  end
end

function script_save(settings)
  for _, a in ipairs(ACTIONS) do
    local arr = obs.obs_hotkey_save(hotkeys[a.id])
    obs.obs_data_set_array(settings, a.id, arr)
    obs.obs_data_array_release(arr)
  end
  obs.obs_data_set_bool(settings, 'bound', true)
end
