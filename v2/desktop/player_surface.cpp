#include "player_surface.h"
#include <QApplication>
#include <QComboBox>
#include <QCursor>
#include <QEvent>
#include <QGridLayout>
#include <QHideEvent>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QVBoxLayout>
#include <QWindow>
namespace wp::ui {
PlayerSurface::PlayerSurface(QWidget *video, QWidget *parent) : QWidget(parent), video_(video) {
  setObjectName(QStringLiteral("PlayerSurface"));
  setFocusPolicy(Qt::StrongFocus);
  setMouseTracking(true);
  setMinimumSize(480, 270);
  setStyleSheet(QStringLiteral(
      "QWidget#PlayerSurface { background: black; }"
      "QWidget#PlayerControls { background: rgba(8, 13, 22, 235); border-top: 1px solid #304158; }"));
  layers_ = new QGridLayout(this);
  layers_->setContentsMargins(0, 0, 0, 0);
  layers_->setSpacing(0);
  layers_->addWidget(video_, 0, 0);
  video_->setMouseTracking(true);
  video_->setFocusPolicy(Qt::StrongFocus);
  controls_ = new QWidget;
  controls_->setObjectName(QStringLiteral("PlayerControls"));
  controls_->setAttribute(Qt::WA_StyledBackground);
  controlLayout_ = new QVBoxLayout(controls_);
  controlLayout_->setContentsMargins(14, 10, 14, 10);
  controlLayout_->setSpacing(8);
  layers_->addWidget(controls_, 0, 0, Qt::AlignBottom);
  idle_.setSingleShot(true);
  idle_.setInterval(2500);
  connect(&idle_, &QTimer::timeout, this, &PlayerSurface::hideIdleControls);
  qApp->installEventFilter(this);
}
PlayerSurface::~PlayerSurface() { qApp->removeEventFilter(this); }
void PlayerSurface::setBlockingOverlay(QWidget *overlay) {
  layers_->addWidget(overlay, 0, 0);
  controls_->raise();
}
void PlayerSurface::addControls(QWidget *controls) {
  controlLayout_->addWidget(controls);
  controls_->raise();
}
bool PlayerSurface::contains(QWidget *widget) const {
  // QWidget::isAncestorOf stops at window boundaries, including combo popups.
  for (auto *ancestor = widget; ancestor; ancestor = ancestor->parentWidget())
    if (ancestor == this)
      return true;
  return false;
}
bool PlayerSurface::controlsVisible() const { return !controls_->isHidden(); }
void PlayerSurface::revealControls() {
  controls_->show();
  controls_->raise();
  unsetCursor();
  video_->unsetCursor();
  if (playing_ && !blocking_ && isVisible())
    idle_.start();
  else
    idle_.stop();
}
void PlayerSurface::setPlaybackState(bool playing, bool blocking) {
  if (playing_ == playing && blocking_ == blocking)
    return;
  playing_ = playing;
  blocking_ = blocking;
  revealControls();
}
void PlayerSurface::hideIdleControls() {
  if (!playing_ || blocking_ || !isVisible())
    return;
  const auto point = mapFromGlobal(QCursor::pos());
  if (QApplication::activePopupWidget() || QApplication::mouseButtons() != Qt::NoButton ||
      (rect().contains(point) && controls_->geometry().contains(point))) {
    idle_.start();
    return;
  }
  // Move focus off a hidden button/slider so Space remains a playback gesture.
  if (controls_->isAncestorOf(QApplication::focusWidget()))
    video_->setFocus(Qt::OtherFocusReason);
  controls_->hide();
  setCursor(Qt::BlankCursor);
  video_->setCursor(Qt::BlankCursor);
}
void PlayerSurface::hideEvent(QHideEvent *event) {
  idle_.stop();
  unsetCursor();
  video_->unsetCursor();
  QWidget::hideEvent(event);
}
bool PlayerSurface::eventFilter(QObject *object, QEvent *event) {
  auto *widget = qobject_cast<QWidget *>(object);
  if (!contains(widget))
    return QWidget::eventFilter(object, event);
  auto *popup = widget->window();
  if (popup != window() && popup->windowType() == Qt::Popup) {
    // Combo boxes can create their native popup before this surface moves.
    // Reparenting the controls does not update that popup's transient owner.
    if (event->type() == QEvent::Show) {
      if (auto *handle = popup->windowHandle()) {
        if (auto *owner = window()->windowHandle(); owner && handle->transientParent() != owner)
          handle->setTransientParent(owner);
        if (QApplication::platformName().startsWith(QStringLiteral("wayland"))) {
          if (auto *combo = qobject_cast<QComboBox *>(popup->parentWidget())) {
            const QRect control(combo->mapTo(window(), QPoint()), combo->size());
            const bool above = window()->isFullScreen() &&
                popup->height() > window()->height() - control.bottom() - 1 &&
                popup->height() <= control.top();
            // Qt 6.12's Wayland positioner overrides QWidget popup placement.
            // Its platform properties (qwaylandxdgshell.cpp) let us place an
            // owned combo above bottom controls before mapping, even when the
            // compositor fails to flip/slide a fullscreen popup. No private
            // headers are used; recheck this compatibility path on Qt upgrades.
            if (above) {
              const bool rtl = combo->layoutDirection() == Qt::RightToLeft;
              handle->setProperty("_q_waylandPopupAnchorRect", control);
              handle->setProperty("_q_waylandPopupAnchor", QVariant::fromValue(
                  Qt::Edges(Qt::TopEdge | (rtl ? Qt::RightEdge : Qt::LeftEdge))));
              handle->setProperty("_q_waylandPopupGravity", QVariant::fromValue(
                  Qt::Edges(Qt::TopEdge | (rtl ? Qt::LeftEdge : Qt::RightEdge))));
            } else {
              for (const auto *property : {"_q_waylandPopupAnchorRect", "_q_waylandPopupAnchor", "_q_waylandPopupGravity"})
                handle->setProperty(property, QVariant());
            }
          }
        }
      }
      idle_.stop();
    } else if (event->type() == QEvent::Hide && playing_ && !blocking_ && isVisible())
      idle_.start();
    // Raising the underlying controls while a popup handles input can disturb
    // its native stacking. The popup keeps its own keyboard/mouse handling.
    return QWidget::eventFilter(object, event);
  }
  switch (event->type()) {
  case QEvent::MouseMove:
  case QEvent::MouseButtonPress:
  case QEvent::Wheel:
  case QEvent::FocusIn:
  case QEvent::Show:
    revealControls();
    break;
  case QEvent::MouseButtonDblClick:
    if ((widget == video_ || widget == this) &&
        static_cast<QMouseEvent *>(event)->button() == Qt::LeftButton) {
      emit fullscreenRequested();
      return true;
    }
    break;
  case QEvent::KeyPress: {
    revealControls();
    // Controls retain their native keyboard behavior; player gestures apply to
    // the video itself, including when the same surface lives in the pop-out.
    if (widget != video_ && widget != this)
      break;
    auto *key = static_cast<QKeyEvent *>(event);
    const bool control = key->modifiers().testFlag(Qt::ControlModifier);
    switch (key->key()) {
    case Qt::Key_Space:
      if (!key->isAutoRepeat()) emit pauseRequested();
      break;
    case Qt::Key_Left:
      if (control) emit chapterRequested(-1); else emit seekRequested(-10);
      break;
    case Qt::Key_Right:
      if (control) emit chapterRequested(1); else emit seekRequested(10);
      break;
    case Qt::Key_Up: emit volumeRequested(5); break;
    case Qt::Key_Down: emit volumeRequested(-5); break;
    case Qt::Key_F11: emit fullscreenRequested(); break;
    case Qt::Key_Escape: emit escapeRequested(); break;
    default: return QWidget::eventFilter(object, event);
    }
    return true;
  }
  default: break;
  }
  return QWidget::eventFilter(object, event);
}
} // namespace wp::ui
