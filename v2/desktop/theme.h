#pragma once
#include <QColor>
#include <QIcon>
#include <QString>
namespace wp::ui {
void installTheme();
QIcon icon(const QString &name, const QColor &color = QColor(QStringLiteral("#b8c9e1")));
} // namespace wp::ui
