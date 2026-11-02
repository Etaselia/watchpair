#pragma once
#include <QJsonObject>
#include <QJsonValue>
#include <QList>
#include <QRect>
class QScreen;
class QWidget;

namespace wp::ui {
QJsonObject windowGeometrySetting(const QRect &normal);
QRect windowGeometryRect(const QJsonValue &setting);
QRect fitWindowGeometry(QRect requested, const QList<QRect> &available, const QRect &preferred,
                        const QSize &minimum = QSize(1, 1));
QRect normalWindowGeometry(const QWidget &window, const QRect &fallback = {});
QRect restoreWindowGeometry(QWidget &window, const QJsonValue &setting, QScreen *preferred = nullptr);
void constrainWindowGeometry(QWidget &window);
} // namespace wp::ui
