#include "theme.h"
#include <QApplication>
#include <QFontDatabase>
#include <QHash>
#include <QPainter>
#include <QPainterPath>
#include <QPalette>
#include <QStyleFactory>
namespace wp::ui {
void installTheme() {
  qApp->setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
  QPalette p;
  p.setColor(QPalette::Window, QColor(QStringLiteral("#0f1622")));
  p.setColor(QPalette::WindowText, QColor(QStringLiteral("#e0e8f4")));
  p.setColor(QPalette::Base, QColor(QStringLiteral("#111b29")));
  p.setColor(QPalette::AlternateBase, QColor(QStringLiteral("#141f2f")));
  p.setColor(QPalette::Text, QColor(QStringLiteral("#dfe7f4")));
  p.setColor(QPalette::Button, QColor(QStringLiteral("#1c2a3f")));
  p.setColor(QPalette::ButtonText, QColor(QStringLiteral("#dfe7f4")));
  p.setColor(QPalette::Highlight, QColor(QStringLiteral("#254b7e")));
  p.setColor(QPalette::HighlightedText, QColor(QStringLiteral("#ffffff")));
  p.setColor(QPalette::ToolTipBase, QColor(QStringLiteral("#1c2b41")));
  p.setColor(QPalette::ToolTipText, QColor(QStringLiteral("#e9f1fc")));
  p.setColor(QPalette::PlaceholderText, QColor(QStringLiteral("#7d90ad")));
  p.setColor(QPalette::Disabled, QPalette::Text, QColor(QStringLiteral("#73839b")));
  p.setColor(QPalette::Disabled, QPalette::ButtonText, QColor(QStringLiteral("#73839b")));
  qApp->setPalette(p);
  QFont font = QFontDatabase::systemFont(QFontDatabase::GeneralFont);
  font.setPointSizeF(10);
  qApp->setFont(font);
  qApp->setStyleSheet(QStringLiteral(R"(
    QWidget { color: #dfe7f4; }
    QMainWindow, QDialog { background: #0f1622; }
    QFrame#Sidebar { background: #0b111c; border-right: 1px solid #243147; }
    QLabel#Brand { font-size: 22px; font-weight: 650; color: #f0f5fd; }
    QLabel#PageTitle, QLabel#pageTitle { font-size: 24px; font-weight: 650; color: #f0f5fd; }
    QLabel#SectionTitle, QLabel#sectionTitle { font-size: 16px; font-weight: 600; color: #edf3fc; }
    QLabel#BrandMark { background: #6599ed; color: #0c1729; border-radius: 9px; font-size: 23px; font-weight: 700; }
    QLabel#BrandName { font-size: 19px; font-weight: 650; }
    QLabel#HeroTitle { font-size: 36px; font-weight: 650; color: #f1f5fc; }
    QLabel#HeroText { font-size: 15px; color: #a9bdd9; line-height: 1.5; }
    QLabel#NavCaption { color: #7286a5; font-size: 10px; font-weight: 600; padding: 6px 2px; }
    QLabel#muted { color: #8fa2bd; }
    QLabel#error { color: #f3b0bf; }
    QLabel[muted="true"] { color: #8fA2bd; }
    QLabel#NavSection { color: #7286a5; font-size: 11px; font-weight: 600; padding: 10px 8px 3px; }
    QLabel#Badge { border: 1px solid #32445f; background: #1c2b42; color: #bcd3f3; border-radius: 5px; padding: 3px 7px; }
    QLabel[tone="good"] { color: #91e0c5; background: #183831; border: 1px solid #2d594e; }
    QFrame#Card, QFrame#card { background: #131e2d; border: 1px solid #27364c; border-radius: 9px; }
    QWidget#Topbar { background: #111b2a; border-bottom: 1px solid #243147; }
    QFrame#IssueBanner { background: #3a2c27; border-bottom: 1px solid #684b40; }
    QFrame#Banner { background: #382e23; border: 1px solid #66503b; border-radius: 7px; }
    QFrame#PlayerFrame { background: #070b12; border: 1px solid #28364a; border-radius: 8px; }
    QFrame#PlayerOverlay { background: rgba(9, 15, 25, 215); border-radius: 7px; }
    QPushButton, QToolButton { background: #1b2a40; border: 1px solid #32445f; border-radius: 6px; padding: 6px 10px; min-height: 20px; }
    QPushButton:hover, QToolButton:hover { background: #263953; border-color: #5275a6; }
    QPushButton:pressed, QToolButton:pressed { background: #17243a; }
    QPushButton:disabled, QToolButton:disabled { background: #162032; border-color: #26344a; color: #6f819d; }
    QPushButton:focus, QToolButton:focus { border: 1px solid #8ab7ff; }
    QPushButton[role="primary"], QPushButton#primary { background: #497ed4; border: 1px solid #6695e2; color: white; font-weight: 600; }
    QPushButton[role="primary"]:hover, QPushButton#primary:hover { background: #6092e0; }
    QPushButton[role="danger"], QPushButton#danger { background: #392633; color: #f3b0bf; border-color: #714153; }
    QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox, QPlainTextEdit { background: #101b2b; border: 1px solid #30435e; border-radius: 6px; padding: 6px 8px; selection-background-color: #315c96; }
    QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus { border-color: #74a7fa; }
    QComboBox::drop-down { width: 22px; border: none; }
    QComboBox QAbstractItemView { background: #17263c; border: 1px solid #3b5377; selection-background-color: #2c5082; }
    QCheckBox { spacing: 7px; padding: 3px; }
    QCheckBox::indicator { width: 16px; height: 16px; }
    QTableView, QTreeView { background: #111b29; alternate-background-color: #141f2f; border: 1px solid #27374f; border-radius: 5px; outline: 0; gridline-color: #233249; selection-background-color: #254b7e; selection-color: #f1f6ff; }
    QTableView::item, QTreeView::item { padding: 4px 6px; border: none; }
    QTableView::item:hover, QTreeView::item:hover { background: #1d304b; }
    QTableView::item:selected, QTreeView::item:selected { background: #254b7e; }
    QHeaderView::section { background: #18263a; color: #9fb3d0; border: none; border-bottom: 1px solid #30415c; border-right: 1px solid #23334b; padding: 7px 8px; font-weight: 500; }
    QTableCornerButton::section { background: #18263a; border: none; }
    QListWidget#Navigation, QListWidget#RoomNavigation { background: transparent; border: none; outline: 0; }
    QListWidget#RoomNavigation::item { padding: 10px 8px; border-radius: 6px; color: #9fb1cc; }
    QListWidget#RoomNavigation::item:hover { background: #16253a; }
    QListWidget#RoomNavigation::item:selected { background: #1c3556; color: #cbe0ff; }
    QListWidget#Navigation::item { padding: 6px 12px; border-radius: 6px; margin: 2px 6px; color: #9fb1cc; }
    QListWidget#Navigation::item:hover { background: #16253a; color: #dbe7f9; }
    QListWidget#Navigation::item:selected { background: #1c3556; color: #cbe0ff; }
    QTabWidget::pane { border: 1px solid #283a54; border-radius: 6px; top: -1px; }
    QTabBar::tab { background: #111c2c; padding: 9px 14px; color: #8ea5c6; border-bottom: 2px solid transparent; }
    QTabBar::tab:selected { background: #182940; color: #dbeaff; border-bottom: 2px solid #7dabfa; }
    QTabBar::tab:hover { background: #1c2d47; }
    QSplitter::handle { background: #152235; }
    QSplitter::handle:hover { background: #3d6394; }
    QProgressBar { background: #20314a; border: none; border-radius: 3px; height: 6px; text-align: center; }
    QProgressBar::chunk { background: #82adfa; border-radius: 3px; }
    QScrollBar:vertical { background: #111b29; width: 10px; margin: 0; }
    QScrollBar::handle:vertical { background: #3b506f; border-radius: 4px; min-height: 28px; }
    QScrollBar:horizontal { background: #111b29; height: 10px; margin: 0; }
    QScrollBar::handle:horizontal { background: #3b506f; border-radius: 4px; min-width: 28px; }
    QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
    QSlider::groove:horizontal { height: 5px; background: #2c3e5b; border-radius: 2px; }
    QSlider::sub-page:horizontal { background: #8cb5fa; border-radius: 2px; }
    QSlider::handle:horizontal { background: #c7ddff; width: 12px; margin: -4px 0; border-radius: 6px; }
    QMenu { background: #17253a; border: 1px solid #3c5476; padding: 5px; }
    QMenu::item { padding: 7px 22px 7px 12px; border-radius: 4px; }
    QMenu::item:selected { background: #2c4e7d; }
    QToolTip { background: #1b2b43; color: #e5edfa; border: 1px solid #45618a; padding: 6px; }
    QStatusBar { background: #0b121e; border-top: 1px solid #233149; color: #8ba0bf; }
    QGroupBox { border: 1px solid #2a3b54; border-radius: 7px; margin-top: 13px; padding-top: 12px; font-weight: 600; }
    QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 5px; }
  )"));
}
QIcon icon(const QString &name, const QColor &color) {
  static QHash<QString, QIcon> cache;
  const auto key = name + color.name();
  if (cache.contains(key))
    return cache.value(key);
  QPixmap pixmap(48, 48);
  pixmap.setDevicePixelRatio(2);
  pixmap.fill(Qt::transparent);
  QPainter p(&pixmap);
  p.setRenderHint(QPainter::Antialiasing);
  p.setPen(QPen(color, 1.7, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
  p.setBrush(Qt::NoBrush);
  auto line = [&](double x, double y, double a, double b) {
    p.drawLine(QPointF(x, y), QPointF(a, b));
  };
  if (name == QStringLiteral("play")) {
    p.setBrush(color);
    p.drawPolygon(QPolygonF{QPointF(8, 5), QPointF(19, 12), QPointF(8, 19)});
  } else if (name == QStringLiteral("pause")) {
    p.setBrush(color);
    p.drawRoundedRect(QRectF(7, 5, 3, 14), 1, 1);
    p.drawRoundedRect(QRectF(14, 5, 3, 14), 1, 1);
  } else if (name == QStringLiteral("next")) {
    p.setBrush(color);
    p.drawPolygon(QPolygonF{QPointF(5, 6), QPointF(15, 12), QPointF(5, 18)});
    line(18, 6, 18, 18);
  } else if (name == QStringLiteral("plus")) {
    line(12, 5, 12, 19);
    line(5, 12, 19, 12);
  } else if (name == QStringLiteral("x")) {
    line(6, 6, 18, 18);
    line(18, 6, 6, 18);
  } else if (name == QStringLiteral("check")) {
    line(5, 12, 10, 17);
    line(10, 17, 19, 7);
  } else if (name == QStringLiteral("up") || name == QStringLiteral("down") ||
             name == QStringLiteral("download")) {
    const bool up = name == QStringLiteral("up");
    line(12, 4, 12, 18);
    line(6, up ? 10 : 12, 12, up ? 4 : 18);
    line(18, up ? 10 : 12, 12, up ? 4 : 18);
    if (name == QStringLiteral("download"))
      line(5, 21, 19, 21);
  } else if (name == QStringLiteral("folder") || name == QStringLiteral("library")) {
    QPainterPath path;
    path.moveTo(3, 7);
    path.lineTo(9, 7);
    path.lineTo(11, 10);
    path.lineTo(21, 10);
    path.lineTo(20, 19);
    path.lineTo(3, 19);
    path.closeSubpath();
    p.drawPath(path);
    line(3, 10, 3, 5);
    line(3, 5, 9, 5);
  } else if (name == QStringLiteral("room")) {
    p.drawRoundedRect(QRectF(3, 4, 18, 13), 2, 2);
    line(8, 21, 16, 21);
    line(12, 17, 12, 21);
    p.setBrush(color);
    p.drawEllipse(QPointF(9, 10), 1.5, 1.5);
    p.drawEllipse(QPointF(15, 10), 1.5, 1.5);
  } else if (name == QStringLiteral("clock")) {
    p.drawEllipse(QRectF(4, 4, 16, 16));
    line(12, 7, 12, 12);
    line(12, 12, 16, 14);
  } else if (name == QStringLiteral("trash")) {
    line(5, 7, 19, 7);
    line(9, 4, 15, 4);
    line(7, 7, 8, 21);
    line(17, 7, 16, 21);
    line(8, 21, 16, 21);
    line(10, 11, 10.5, 17);
    line(14, 11, 13.5, 17);
  } else if (name == QStringLiteral("search")) {
    p.drawEllipse(QRectF(4, 4, 11, 11));
    line(14, 14, 20, 20);
  } else if (name == QStringLiteral("share")) {
    p.drawEllipse(QRectF(3, 9, 5, 5));
    p.drawEllipse(QRectF(16, 3, 5, 5));
    p.drawEllipse(QRectF(16, 16, 5, 5));
    line(8, 10, 16, 6);
    line(8, 13, 16, 18);
  } else if (name == QStringLiteral("fullscreen")) {
    for (const auto &origin : {QPointF(4, 4), QPointF(20, 4), QPointF(4, 20), QPointF(20, 20)}) {
      const int dx = origin.x() < 12 ? 1 : -1, dy = origin.y() < 12 ? 1 : -1;
      line(origin.x(), origin.y(), origin.x() + dx * 5, origin.y());
      line(origin.x(), origin.y(), origin.x(), origin.y() + dy * 5);
    }
  } else if (name == QStringLiteral("refresh")) {
    p.drawArc(QRectF(4, 4, 16, 16), 40 * 16, 280 * 16);
    line(20, 5, 20, 10);
    line(20, 10, 15, 10);
  } else if (name == QStringLiteral("volume")) {
    p.drawPolygon(QPolygonF{QPointF(4, 10), QPointF(8, 10), QPointF(13, 6), QPointF(13, 18), QPointF(8, 14),
                            QPointF(4, 14)});
    p.drawArc(QRectF(10, 6, 11, 12), -60 * 16, 120 * 16);
  } else if (name == QStringLiteral("settings")) {
    p.drawEllipse(QRectF(5, 5, 14, 14));
    p.drawEllipse(QRectF(9, 9, 6, 6));
    for (int i = 0; i < 8; ++i) {
      p.save();
      p.translate(12, 12);
      p.rotate(i * 45);
      p.drawLine(QPointF(0, -9), QPointF(0, -7));
      p.restore();
    }
  } else {
    p.drawRoundedRect(QRectF(4, 4, 16, 16), 3, 3);
    line(8, 9, 16, 9);
    line(8, 13, 16, 13);
    line(8, 17, 13, 17);
  }
  p.end();
  const QIcon result(pixmap);
  cache.insert(key, result);
  return result;
}
} // namespace wp::ui
