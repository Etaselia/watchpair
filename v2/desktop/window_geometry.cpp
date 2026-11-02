#include "window_geometry.h"
#include <QGuiApplication>
#include <QScreen>
#include <QWidget>
#include <algorithm>

namespace wp::ui {
namespace {
QList<QRect> workAreas() {
  QList<QRect> result;
  for (const auto *screen : QGuiApplication::screens())
    result.append(screen->availableGeometry());
  return result;
}
bool positionsSupported() {
  return !QGuiApplication::platformName().startsWith(QStringLiteral("wayland"));
}
QSize minimumSize(const QWidget &window) {
  return window.minimumSize().expandedTo(window.minimumSizeHint()).expandedTo(QSize(1, 1));
}
} // namespace

QJsonObject windowGeometrySetting(const QRect &normal) {
  return {{QStringLiteral("x"), normal.x()}, {QStringLiteral("y"), normal.y()},
          {QStringLiteral("width"), normal.width()}, {QStringLiteral("height"), normal.height()}};
}
QRect windowGeometryRect(const QJsonValue &setting) {
  const auto object = setting.toObject();
  return {object.value(QStringLiteral("x")).toInt(), object.value(QStringLiteral("y")).toInt(),
          object.value(QStringLiteral("width")).toInt(), object.value(QStringLiteral("height")).toInt()};
}
QRect fitWindowGeometry(QRect requested, const QList<QRect> &available, const QRect &preferred,
                        const QSize &minimum) {
  auto area = preferred.isValid() ? preferred : QRect(0, 0, 1280, 720);
  if (!available.isEmpty() && !available.contains(area))
    area = available.first();
  qint64 overlap = 0;
  for (const auto &candidate : available) {
    const auto intersection = requested.intersected(candidate);
    const qint64 pixels = qint64(intersection.width()) * intersection.height();
    if (pixels > overlap) {
      area = candidate;
      overlap = pixels;
    }
  }
  const bool saved = requested.isValid();
  auto size = (saved ? requested.size() : QSize(1000, 650))
                  .expandedTo(minimum.boundedTo(area.size())).boundedTo(area.size());
  if (!saved)
    requested = QRect(area.center() - QPoint(size.width() / 2, size.height() / 2), size);
  requested.setSize(size);
  requested.moveLeft(std::clamp(requested.left(), area.left(), area.right() - size.width() + 1));
  requested.moveTop(std::clamp(requested.top(), area.top(), area.bottom() - size.height() + 1));
  return requested;
}
QRect normalWindowGeometry(const QWidget &window, const QRect &fallback) {
  const auto normal = window.isFullScreen() || window.isMaximized() || window.isMinimized()
                          ? window.normalGeometry() : window.geometry();
  return normal.isValid() ? normal : fallback;
}
QRect restoreWindowGeometry(QWidget &window, const QJsonValue &setting, QScreen *preferred) {
  if (!preferred)
    preferred = QGuiApplication::primaryScreen();
  const auto restored = fitWindowGeometry(windowGeometryRect(setting), workAreas(),
      preferred ? preferred->availableGeometry() : QRect(), minimumSize(window));
  if (positionsSupported())
    window.setGeometry(restored);
  else
    window.resize(restored.size()); // The Wayland compositor owns top-level placement.
  return restored;
}
void constrainWindowGeometry(QWidget &window) {
  if (!positionsSupported() || window.isFullScreen() || window.isMaximized() || window.isMinimized())
    return;
  const auto client = window.geometry(), frame = window.frameGeometry();
  const QMargins margins(client.left() - frame.left(), client.top() - frame.top(),
                         frame.right() - client.right(), frame.bottom() - client.bottom());
  const auto fitted = fitWindowGeometry(frame, workAreas(),
      window.screen() ? window.screen()->availableGeometry() : QRect(),
      minimumSize(window) + QSize(margins.left() + margins.right(), margins.top() + margins.bottom()));
  if (fitted != frame)
    window.setGeometry(fitted.marginsRemoved(margins));
}
} // namespace wp::ui
