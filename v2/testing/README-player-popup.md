# Player dropdown regression

`player-surface-tests` covers cached combo popup ownership while the same surface
moves between the room, pop-out, fullscreen, and room again. The native
`player-presentation-tests` target repeats those clicks over the actual renderer
with an embedded subtitle track. Both require an exposed popup, a mouse press
on the expected list row, and the matching `activated` selection.

For native Wayland input, run:

```sh
bash v2/testing/test-player-popup-wayland.sh \
  outputs/v2/app-linux-qt612/desktop/player-surface-tests outputs/popup-wayland
bash v2/testing/test-player-popup-wayland.sh \
  outputs/v2/app-linux-qt612/desktop/player-presentation-tests outputs/popup-renderer-wayland \
  nativeRendererSurvivesFullscreenPopoutAndReturnWithWorkingSeeks
```

The harness requires Python 3, Xvfb, Weston, libX11, and libXtst. It creates a
dedicated virtual X11 display and nested Weston compositor. XTest clicks supply
real Wayland input serials; Qt's synthetic widget clicks cannot do so. The
helper binds input to the test process's compositor surface and checks popup
bounds against the output before clicking. Saved `*-screen.png` files capture
the actual compositor, including dropdowns above the video. Enable
`WATCHPAIR_POPUP_WAYLAND_DEBUG=1` to retain the positioner protocol in
`native-stderr.txt`.

The Qt 6.12 Wayland platform can replace QComboBox's QWidget placement with a
below-control native anchor. The captured fresh-fullscreen control requested
flip/slide constraints but was configured below the output. PlayerSurface
therefore uses the platform's `_q_waylandPopupAnchorRect` (QRect),
`_q_waylandPopupAnchor`, and `_q_waylandPopupGravity` (both Qt::Edges) properties
before mapping an owned fullscreen combo whose list fits above but not below.
These are private platform properties supported by the pinned Qt 6.12
`qwaylandxdgshell.cpp`; review this compatibility path on Qt upgrades. Other
platforms retain their normal placement. Each subsequent show clears the
overrides when the upward placement is no longer needed.

Qt 6.12 also ignores the opening mouse release using a 400 ms wall timer.
Under software rendering, a quick native release can reach the popup after
that timer expires and select the row beneath the opening arrow. The Wayland
compatibility guard compares the same gesture's wrapping native timestamps
and global coordinates instead. It clears on subsequent presses, releases,
movement beyond the drag threshold, or hiding. The delayed-release regression
replays a real 50 ms opening click's release after 500 ms without changing its
timestamp or position; opening must activate nothing, then a deliberate row
click must work. A separate native press-drag-release case preserves selection
by dragging into the list. These two tests require the Wayland harness.
