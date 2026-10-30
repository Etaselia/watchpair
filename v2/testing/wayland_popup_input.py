#!/usr/bin/env python3
"""QA-only native XTest input for a nested Weston X11 compositor."""
import ctypes as c
import os
import re
import struct
import subprocess
import sys
import time
import zlib

if os.environ.get('WATCHPAIR_POPUP_XVFB_CHILD') != '1':
    raise RuntimeError('Run through test-player-popup-wayland.sh on its isolated Xvfb display')

x = c.CDLL('libX11.so.6')
xt = c.CDLL('libXtst.so.6')
display_type, window_type = c.c_void_p, c.c_ulong
x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [c.c_char_p], display_type
x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [display_type], window_type
x.XQueryTree.argtypes = [display_type, window_type, c.POINTER(window_type), c.POINTER(window_type), c.POINTER(c.POINTER(window_type)), c.POINTER(c.c_uint)]
x.XFetchName.argtypes = [display_type, window_type, c.POINTER(c.c_char_p)]
x.XFree.argtypes = [c.c_void_p]
x.XTranslateCoordinates.argtypes = [display_type, window_type, window_type, c.c_int, c.c_int, c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(window_type)]
x.XGetGeometry.argtypes = [display_type, window_type, c.POINTER(window_type), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]
x.XSync.argtypes = [display_type, c.c_int]
xt.XTestFakeMotionEvent.argtypes = [display_type, c.c_int, c.c_int, c.c_int, c.c_ulong]
xt.XTestFakeButtonEvent.argtypes = [display_type, c.c_uint, c.c_int, c.c_ulong]
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError('No nested compositor X11 display')
root = x.XDefaultRootWindow(display)
root_out, parent_out, children, count = window_type(), window_type(), c.POINTER(window_type)(), c.c_uint()
if not x.XQueryTree(display, root, c.byref(root_out), c.byref(parent_out), c.byref(children), c.byref(count)):
    raise RuntimeError('Cannot inspect X11 display tree')
compositors = []
labels = []
for i in range(count.value):
    name = c.c_char_p()
    if x.XFetchName(display, children[i], c.byref(name)) and name.value:
        label = name.value.decode(errors='replace')
        labels.append(label)
        if 'weston' in label.lower():
            compositors.append((children[i], label))
        x.XFree(name)
# Weston may publish only _NET_WM_NAME. The launcher reserves a fresh Xvfb
# display exclusively for this one compositor, so a sole child is unambiguous.
if not compositors and count.value == 1:
    compositors.append((children[0], 'sole nested compositor'))
x.XFree(children)
if len(compositors) != 1:
    raise RuntimeError(f'Expected exactly one nested Weston window: {compositors}; visible labels: {labels}')
origin_x, origin_y, child = c.c_int(), c.c_int(), window_type()
x.XTranslateCoordinates(display, compositors[0][0], root, 0, 0, c.byref(origin_x), c.byref(origin_y), c.byref(child))

if sys.argv[1] in ('click', 'press', 'release'):
    action = sys.argv[1]
    pid, kind, local_x, local_y = sys.argv[2:6]
    pattern = rf'View \d+ \(role xdg_{re.escape(kind)}, PID {int(pid)},[^\n]+\n\s+position: \((-?\d+), (-?\d+)\) -> \((-?\d+), (-?\d+)\)'
    deadline = time.monotonic() + 3
    while True:
        graph = subprocess.run(['weston-debug', 'scene-graph'], capture_output=True, text=True, check=True, timeout=3).stdout
        matches = re.findall(pattern, graph)
        if len(matches) == 1:
            left, top, right, bottom = map(int, matches[0])
            if kind != 'toplevel' or len(sys.argv) <= 7 or (right-left, bottom-top) == tuple(map(int, sys.argv[6:8])):
                break
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Committed {kind} surface did not match requested geometry: {matches}\n{graph}')
        time.sleep(.02)
    if os.environ.get('WATCHPAIR_UI_OUTPUT'):
        stamp = str(time.time_ns())
        with open(os.path.join(os.environ['WATCHPAIR_UI_OUTPUT'], f'scene-{kind}-{stamp}.txt'), 'w') as output:
            output.write(graph)
        subprocess.run([sys.executable, __file__, 'capture', os.path.join(os.environ['WATCHPAIR_UI_OUTPUT'], f'before-{kind}-{stamp}.png')], check=True)
    if len(matches) != 1:
        raise RuntimeError(f'Expected one {kind} for PID {pid}, found {matches}\n{graph}')
    px, py, right, bottom = map(int, matches[0])
    if kind == 'popup':
        outputs = re.findall(r'Output \d+[^\n]*\n\s+position: \((-?\d+), (-?\d+)\) -> \((-?\d+), (-?\d+)\)', graph)
        if len(outputs) != 1:
            raise RuntimeError(f'Expected one isolated compositor output: {outputs}')
        left_edge, top_edge, right_edge, bottom_edge = map(int, outputs[0])
        if not (left_edge <= px < right <= right_edge and top_edge <= py < bottom <= bottom_edge):
            raise RuntimeError(f'Popup {matches[0]} is clipped by compositor output {outputs[0]}')
        if len(sys.argv) > 6:
            owners = re.findall(rf'View \d+ \(role xdg_toplevel, PID {int(pid)},[^\n]+\n\s+position: \((-?\d+), (-?\d+)\) ->', graph)
            if len(owners) != 1 or bottom > int(owners[0][1]) + int(sys.argv[6]):
                raise RuntimeError(f'Fullscreen popup {matches[0]} is not above its control')
        print(f'Popup {matches[0]} fully within output {outputs[0]}', flush=True)
    if not (0 <= int(local_x) < right - px and 0 <= int(local_y) < bottom - py):
        raise RuntimeError(f'Click point {local_x},{local_y} is outside committed {kind} surface {matches[0]}')
    px += origin_x.value + int(local_x)
    py += origin_y.value + int(local_y)
    print(f'Native XTest {kind} {action} at {px},{py}', flush=True)
    xt.XTestFakeMotionEvent(display, -1, px, py, 0)
    if action != 'release':
        xt.XTestFakeButtonEvent(display, 1, 1, 0)
    x.XSync(display, 0)
    if action != 'press':
        time.sleep(.05)
        xt.XTestFakeButtonEvent(display, 1, 0, 0)
    x.XSync(display, 0)
elif sys.argv[1] == 'capture':
    class Image(c.Structure):
        _fields_ = [('width', c.c_int), ('height', c.c_int), ('xoffset', c.c_int), ('format', c.c_int),
                    ('data', c.c_void_p), ('byte_order', c.c_int), ('bitmap_unit', c.c_int),
                    ('bitmap_bit_order', c.c_int), ('bitmap_pad', c.c_int), ('depth', c.c_int),
                    ('bytes_per_line', c.c_int), ('bits_per_pixel', c.c_int),
                    ('red_mask', c.c_ulong), ('green_mask', c.c_ulong), ('blue_mask', c.c_ulong)]
    x.XGetImage.argtypes = [display_type, window_type, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_ulong, c.c_int]
    x.XGetImage.restype = c.POINTER(Image)
    x.XDestroyImage.argtypes = [c.POINTER(Image)]
    width, height, border, depth = c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
    if not x.XGetGeometry(display, compositors[0][0], c.byref(root_out), c.byref(origin_x), c.byref(origin_y), c.byref(width), c.byref(height), c.byref(border), c.byref(depth)):
        raise RuntimeError('Cannot query nested compositor geometry')
    width, height = width.value, height.value
    image = x.XGetImage(display, compositors[0][0], 0, 0, width, height, c.c_ulong(-1).value, 2)
    if not image:
        raise RuntimeError('Cannot capture nested compositor')
    im = image.contents
    if (im.bits_per_pixel, im.byte_order, im.red_mask, im.green_mask, im.blue_mask) != (32, 0, 0xff0000, 0xff00, 0xff):
        raise RuntimeError('Unexpected X11 capture pixel format')
    data = c.string_at(im.data, im.bytes_per_line * im.height)
    rows = bytearray()
    for row in range(im.height):
        pixels = data[row * im.bytes_per_line:row * im.bytes_per_line + im.width * 4]
        rows.append(0)
        for col in range(im.width):
            rows.extend(pixels[col*4:col*4+3][::-1])
    x.XDestroyImage(image)
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    with open(sys.argv[2], 'wb') as output:
        output.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
else:
    raise RuntimeError('Expected click, press, release, or capture')
