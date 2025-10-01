//! FFI for Deno serial: blocking serialport-rs + C ABI
use once_cell::sync::Lazy;
use slab::Slab;
use std::{
    ffi::{CStr, CString},
    io::{Read, Write},
    os::raw::{c_char, c_int},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

static LAST_ERROR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
fn set_err<E: std::fmt::Display>(e: E) -> c_int {
    *LAST_ERROR.lock().unwrap() = Some(e.to_string());
    -1
}

#[no_mangle]
pub extern "C" fn serial_err_len() -> usize {
    LAST_ERROR
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.len() + 1)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn serial_err_fill(out: *mut u8, len: usize) {
    if out.is_null() || len == 0 {
        return;
    }
    if let Some(s) = LAST_ERROR.lock().unwrap().as_ref() {
        let bytes = s.as_bytes();
        let n = bytes.len().min(len - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n);
            *out.add(n) = 0;
        }
    }
}

struct PortState {
    port: Box<dyn serialport::SerialPort + Send>,
}

static HANDLES: Lazy<Mutex<Slab<PortState>>> = Lazy::new(|| Mutex::new(Slab::new()));
static mut LAST_HANDLE: u64 = 0;

fn insert_handle(p: PortState) -> u64 {
    let mut slab = HANDLES.lock().unwrap();
    let key = slab.insert(p);
    key as u64
}

fn with_state_mut<F, R>(h: u64, f: F) -> Result<R, c_int>
where
    F: FnOnce(&mut PortState) -> Result<R, c_int>,
{
    let mut slab = HANDLES.lock().unwrap();
    let idx = h as usize;
    if let Some(state) = slab.get_mut(idx) {
        f(state)
    } else {
        Err(set_err("invalid handle"))
    }
}

#[no_mangle]
pub extern "C" fn serial_open(
    path: *const c_char,
    baud: u32,
    data_bits: u8,
    parity: u8,
    stop_bits: u8,
    rtscts: u8,
    xon: u8,
    xoff: u8,
    _xany: u8,
    read_timeout_ms: i32,
) -> c_int {
    let path = unsafe { CStr::from_ptr(path) };
    let path = match path.to_str() {
        Ok(s) => s,
        Err(e) => return set_err(e),
    };

    let mut builder = serialport::new(path, baud);
    builder = builder
        .data_bits(match data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .parity(match parity {
            1 => serialport::Parity::Odd,
            2 => serialport::Parity::Even,
            _ => serialport::Parity::None,
        })
        .stop_bits(match stop_bits {
            2 => serialport::StopBits::Two,
            _ => serialport::StopBits::One,
        })
        .flow_control(if rtscts != 0 {
            serialport::FlowControl::Hardware
        } else if xon != 0 || xoff != 0 {
            serialport::FlowControl::Software
        } else {
            serialport::FlowControl::None
        });

    // Many implementations prefer a finite read timeout. When -1 is passed,
    // set a reasonably large timeout instead of infinite.
    if read_timeout_ms >= 0 {
        builder = builder.timeout(Duration::from_millis(read_timeout_ms as u64));
    } else {
        builder = builder.timeout(Duration::from_millis(10_000));
    }

    match builder.open() {
        Ok(port) => {
            let h = insert_handle(PortState { port });
            unsafe {
                LAST_HANDLE = h;
            }
            0
        }
        Err(e) => set_err(e),
    }
}

#[no_mangle]
pub extern "C" fn serial_last_handle() -> u64 {
    unsafe { LAST_HANDLE }
}

#[no_mangle]
pub extern "C" fn serial_close(h: u64) -> c_int {
    let mut slab = HANDLES.lock().unwrap();
    let idx = h as usize;
    if slab.contains(idx) {
        slab.remove(idx);
        0
    } else {
        set_err("invalid handle")
    }
}

#[no_mangle]
pub extern "C" fn serial_write(h: u64, buf: *const u8, len: usize) -> isize {
    if buf.is_null() {
        return set_err("null buffer") as isize;
    }
    let res = with_state_mut(h, |state| {
        let data = unsafe { std::slice::from_raw_parts(buf, len) };
        match state.port.write(data) {
            Ok(n) => Ok(n as isize),
            Err(e) => Err(set_err(e)),
        }
    });
    match res {
        Ok(n) => n,
        Err(code) => code as isize,
    }
}

// If timeout_ms >= 0, update the read timeout for this call.
#[no_mangle]
pub extern "C" fn serial_read(h: u64, buf: *mut u8, len: usize, timeout_ms: i32) -> isize {
    if buf.is_null() {
        return set_err("null buffer") as isize;
    }
    let res = with_state_mut(h, |state| {
        if timeout_ms >= 0 {
            let _ = state
                .port
                .set_timeout(Duration::from_millis(timeout_ms as u64));
        }
        let out = unsafe { std::slice::from_raw_parts_mut(buf, len) };
        match state.port.read(out) {
            Ok(n) => Ok(n as isize),
            Err(e) => {
                // Treat timeout as 0 bytes so JS can easily retry.
                if e.kind() == std::io::ErrorKind::TimedOut {
                    Ok(0)
                } else {
                    Err(set_err(e))
                }
            }
        }
    });
    match res {
        Ok(n) => n,
        Err(code) => code as isize,
    }
}

// rts/dtr/brk: -1=unchanged, 0=OFF, 1=ON
#[no_mangle]
pub extern "C" fn serial_set_lines(h: u64, rts: c_int, dtr: c_int, brk: c_int) -> c_int {
    with_state_mut(h, |state| {
        if rts >= 0 {
            state
                .port
                .write_request_to_send(rts != 0)
                .map_err(set_err)?;
        }
        if dtr >= 0 {
            state
                .port
                .write_data_terminal_ready(dtr != 0)
                .map_err(set_err)?;
        }
        if brk >= 0 {
            if brk != 0 {
                // Some platforms may not support break set/clear
                state.port.set_break().map_err(set_err)?;
            } else {
                state.port.clear_break().map_err(set_err)?;
            }
        }
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

// Return bit mask: 1<<0=CTS, 1<<1=DSR, 1<<2=DCD, 1<<3=RI
#[no_mangle]
pub extern "C" fn serial_get_lines(h: u64, out_mask: *mut u32) -> c_int {
    if out_mask.is_null() {
        return set_err("null mask");
    }
    let res = with_state_mut(h, |state| {
        let mut mask: u32 = 0;
        if let Ok(b) = state.port.read_clear_to_send() {
            if b {
                mask |= 1 << 0;
            }
        }
        if let Ok(b) = state.port.read_data_set_ready() {
            if b {
                mask |= 1 << 1;
            }
        }
        if let Ok(b) = state.port.read_carrier_detect() {
            if b {
                mask |= 1 << 2;
            }
        }
        if let Ok(b) = state.port.read_ring_indicator() {
            if b {
                mask |= 1 << 3;
            }
        }
        unsafe {
            *out_mask = mask;
        }
        Ok(0)
    });
    res.unwrap_or_else(|code| code)
}

// Purge input/output buffers
#[no_mangle]
pub extern "C" fn serial_flush(h: u64, flush_in: c_int, flush_out: c_int) -> c_int {
    with_state_mut(h, |state| {
        use serialport::ClearBuffer;
        if flush_in != 0 && flush_out != 0 {
            state.port.clear(ClearBuffer::All).map_err(set_err)?;
        } else if flush_in != 0 {
            state.port.clear(ClearBuffer::Input).map_err(set_err)?;
        } else if flush_out != 0 {
            state.port.clear(ClearBuffer::Output).map_err(set_err)?;
        }
        Ok(0)
    })
    .unwrap_or_else(|code| code)
}

// Best-effort drain: wait until bytes_to_write() becomes 0 (with an upper bound)
#[no_mangle]
pub extern "C" fn serial_drain(h: u64) -> c_int {
    const MAX_WAIT: Duration = Duration::from_secs(10);
    const SLEEP: Duration = Duration::from_millis(5);

    let start = Instant::now();
    loop {
        let left = {
            let res = with_state_mut(h, |state| match state.port.bytes_to_write() {
                Ok(n) => Ok(n),
                Err(e) => Err(set_err(e)),
            });
            match res {
                Ok(n) => n,
                Err(code) => return code,
            }
        };
        if left == 0 {
            return 0;
        }
        if start.elapsed() > MAX_WAIT {
            return set_err("drain timeout");
        }
        thread::sleep(SLEEP);
    }
}

#[no_mangle]
pub extern "C" fn serial_list_ports_len() -> usize {
    match serialport::available_ports() {
        Ok(ports) => ports.len(),
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn serial_list_ports_fill(out_ptrs: *mut *mut c_char, cap: usize) -> usize {
    if out_ptrs.is_null() {
        return 0;
    }
    let ports = match serialport::available_ports() {
        Ok(p) => p,
        Err(e) => {
            set_err(e);
            return 0;
        }
    };
    let n = std::cmp::min(ports.len(), cap);
    for (i, p) in ports.into_iter().take(n).enumerate() {
        let json = match port_to_json(&p) {
            Ok(s) => s,
            Err(e) => {
                set_err(e);
                "{}".to_string()
            }
        };
        let cstr = CString::new(json).unwrap_or_else(|_| CString::new("{}").unwrap());
        let raw = cstr.into_raw();
        unsafe {
            *out_ptrs.add(i) = raw;
        }
    }
    n
}

fn port_to_json(p: &serialport::SerialPortInfo) -> Result<String, String> {
    use serialport::SerialPortType::*;
    let mut m = serde_json::json!({
        "path": p.port_name,
    });
    match &p.port_type {
        UsbPort(u) => {
            if let Some(s) = &u.manufacturer {
                m["manufacturer"] = serde_json::Value::String(s.clone());
            }
            // vid/pid are u16 in serialport 4.x
            m["vendorId"] = serde_json::Value::String(format!("{:04x}", u.vid));
            m["productId"] = serde_json::Value::String(format!("{:04x}", u.pid));
            if let Some(s) = &u.serial_number {
                m["serialNumber"] = serde_json::Value::String(s.clone());
            }
        }
        BluetoothPort => {}
        PciPort => {}
        Unknown => {}
    }
    serde_json::to_string(&m).map_err(|e| e.to_string())
}

#[no_mangle]
pub extern "C" fn serial_free_cstr(p: *mut c_char) {
    if p.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(p);
    }
}

// Future work: modem event waiting and explicit cancel APIs
