#include "player_surface.h"
#include <QAbstractItemView>
#include <QApplication>
#include <QComboBox>
#include <QCursor>
#include <QEnterEvent>
#include <QEvent>
#include <QFocusEvent>
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
  controls_->hide();
  idle_.setSingleShot(true);
  idle_.setInterval(1000);
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
bool PlayerSurface::controlsInUse() const {
  auto *popup = QApplication::activePopupWidget();
  auto *focus = QApplication::focusWidget();
  return (popup && contains(popup)) || pressedControl_ ||
      (keyboardControls_ && focus && (focus == controls_ || controls_->isAncestorOf(focus)));
}
void PlayerSurface::showControls() {
  controls_->show();
  auto *popup = QApplication::activePopupWidget();
  if (!popup || !contains(popup))
    controls_->raise();
  unsetCursor();
  video_->unsetCursor();
}
void PlayerSurface::hideControls() {
  idle_.stop();
  // Hidden controls must not retain Space/arrow-key handling after a mouse
  // interaction. Keyboard navigation itself keeps the controls visible.
  if (controls_->isAncestorOf(QApplication::focusWidget()))
    video_->setFocus(Qt::OtherFocusReason);
  controls_->hide();
  if (pointerInside_ && playing_ && !blocking_) {
    setCursor(Qt::BlankCursor);
    video_->setCursor(Qt::BlankCursor);
  } else {
    unsetCursor();
    video_->unsetCursor();
  }
}
void PlayerSurface::updatePointer(const QPoint &globalPosition) {
  pointerPosition_ = mapFromGlobal(globalPosition);
  pointerInside_ = rect().contains(pointerPosition_);
}
void PlayerSurface::updateVisibility() {
  if (!isVisible()) {
    idle_.stop();
    return;
  }
  if (controlsInUse()) {
    idle_.stop();
    showControls();
  } else if (!pointerInside_)
    hideControls();
  else if (qint64(pointerPosition_.y()) * 4 >= qint64(height()) * 3) {
    idle_.stop();
    showControls();
  } else if (controlsVisible() && !idle_.isActive())
    idle_.start();
}
void PlayerSurface::refreshPointerLater() {
  QTimer::singleShot(0, this, [this] { updateVisibility(); });
}
void PlayerSurface::revealControls() {
  // Also used after reparent/fullscreen changes: follow the pointer instead of
  // exposing subtitles to a fresh overlay on every presentation transition.
  updatePointer(QCursor::pos());
  updateVisibility();
}
void PlayerSurface::setPlaybackState(bool playing, bool blocking) {
  if (playing_ == playing && blocking_ == blocking)
    return;
  playing_ = playing;
  blocking_ = blocking;
  // Playback/buffering refreshes do not reveal controls or restart the hover
  // deadline. The same mouse rules apply while playing and paused.
  if (controlsVisible() || !pointerInside_ || !playing_ || blocking_) {
    unsetCursor();
    video_->unsetCursor();
  } else {
    setCursor(Qt::BlankCursor);
    video_->setCursor(Qt::BlankCursor);
  }
}
void PlayerSurface::hideIdleControls() {
  if (!isVisible())
    return;
  if (controlsInUse() || (pointerInside_ && qint64(pointerPosition_.y()) * 4 >= qint64(height()) * 3)) {
    updateVisibility();
    return;
  }
  hideControls();
}
void PlayerSurface::hideEvent(QHideEvent *event) {
  openingCombo_.clear();
  openingTimestamp_ = 0;
  pressedControl_.clear();
  ++controlPressGeneration_;
  keyboardControls_ = false;
  pointerInside_ = false;
  idle_.stop();
  unsetCursor();
  video_->unsetCursor();
  QWidget::hideEvent(event);
}
bool PlayerSurface::eventFilter(QObject *object, QEvent *event) {
  auto *widget = qobject_cast<QWidget *>(object);
  const bool owned = contains(widget);
  if (event->type() == QEvent::ApplicationDeactivate) {
    pressedControl_.clear();
    ++controlPressGeneration_;
    keyboardControls_ = false;
    pointerInside_ = false;
    hideControls();
  }
  // The native window also sees motion over child widgets without mouse
  // tracking (labels/buttons); those moves must still obey the hover zones.
  if ((widget || qobject_cast<QWindow *>(object)) &&
      (event->type() == QEvent::MouseMove || event->type() == QEvent::MouseButtonPress ||
       event->type() == QEvent::MouseButtonRelease)) {
    const auto *mouse = static_cast<QMouseEvent *>(event);
    updatePointer(mouse->globalPosition().toPoint());
    keyboardControls_ = false;
    if (owned && event->type() == QEvent::MouseButtonPress &&
        (widget == controls_ || controls_->isAncestorOf(widget))) {
      pressedControl_ = widget;
      ++controlPressGeneration_;
    }
    if (event->type() == QEvent::MouseButtonRelease && pressedControl_) {
      // Deliver the release before hiding a grabbed slider/button. Otherwise
      // the slider's release (and the room's single guarded seek) can be lost.
      QTimer::singleShot(0, this, [this, generation = controlPressGeneration_] {
        if (generation != controlPressGeneration_)
          return;
        pressedControl_.clear();
        updateVisibility();
      });
    }
    if (owned || controlsVisible())
      updateVisibility();
  }
  if (widget && event->type() == QEvent::MouseButtonPress) {
    openingCombo_.clear();
    openingTimestamp_ = 0;
    if (owned && QApplication::platformName().startsWith(QStringLiteral("wayland"))) {
      auto *combo = qobject_cast<QComboBox *>(widget);
      const auto *mouse = static_cast<QMouseEvent *>(event);
      if (combo && mouse->button() == Qt::LeftButton && mouse->timestamp() > 0 && !combo->view()->isVisible()) {
        openingCombo_ = combo;
        openingTimestamp_ = mouse->timestamp();
        openingPosition_ = mouse->globalPosition();
      }
    }
  } else if (widget && event->type() == QEvent::MouseButtonRelease) {
    const auto *mouse = static_cast<QMouseEvent *>(event);
    auto *combo = qobject_cast<QComboBox *>(openingCombo_.data());
    // Wayland input uses a wrapping 32-bit millisecond timestamp. Qt's popup
    // 400 ms opening timer (Qt 6.12 qcombobox.cpp) can expire while the GUI is
    // busy before a quick release is delivered, selecting the opening row.
    const quint32 elapsed = quint32(mouse->timestamp()) - quint32(openingTimestamp_);
    const bool openingRelease = owned && combo && openingTimestamp_ > 0 &&
        widget->window() == combo->view()->window() && mouse->button() == Qt::LeftButton &&
        elapsed <= 400 &&
        (mouse->globalPosition() - openingPosition_).manhattanLength() <= QApplication::startDragDistance();
    openingCombo_.clear();
    openingTimestamp_ = 0;
    if (openingRelease)
      return true;
  } else if (widget && openingCombo_) {
    const bool moved = event->type() == QEvent::MouseMove &&
        (static_cast<QMouseEvent *>(event)->globalPosition() - openingPosition_).manhattanLength() >
            QApplication::startDragDistance();
    const bool hidden = event->type() == QEvent::Hide &&
        (widget == openingCombo_ || widget == openingCombo_->window() ||
         widget == qobject_cast<QComboBox *>(openingCombo_.data())->view()->window());
    if (moved || hidden) {
      openingCombo_.clear();
      openingTimestamp_ = 0;
    }
  }
  if (!owned)
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
      // Show happens before the native popup is mapped. Do not raise the
      // underlying controls here or during an owned popup's input handling.
      controls_->show();
      unsetCursor();
      video_->unsetCursor();
    } else if (event->type() == QEvent::Hide)
      refreshPointerLater();
    // Raising the underlying controls while a popup handles input can disturb
    // its native stacking. The popup keeps its own keyboard/mouse handling.
    return QWidget::eventFilter(object, event);
  }
  switch (event->type()) {
  case QEvent::Enter:
    keyboardControls_ = false;
    updatePointer(static_cast<QEnterEvent *>(event)->globalPosition().toPoint());
    updateVisibility();
    break;
  case QEvent::Leave:
    // Child Leave events occur while moving video -> controls -> button. Only
    // the actual surface boundary may instantly hide the controls.
    if (widget == this) {
      keyboardControls_ = false;
      updatePointer(QCursor::pos());
      pointerInside_ = false;
      updateVisibility();
    }
    break;
  case QEvent::FocusIn: {
    const auto reason = static_cast<QFocusEvent *>(event)->reason();
    if ((widget == controls_ || controls_->isAncestorOf(widget)) &&
        (reason == Qt::TabFocusReason || reason == Qt::BacktabFocusReason || reason == Qt::ShortcutFocusReason)) {
      keyboardControls_ = true;
      updateVisibility();
    }
    break;
  }
  case QEvent::FocusOut:
    refreshPointerLater();
    break;
  case QEvent::UngrabMouse:
    if (widget == pressedControl_) {
      pressedControl_.clear();
      ++controlPressGeneration_;
      refreshPointerLater();
    }
    break;
  case QEvent::Resize:
  case QEvent::Show:
    if (widget == this)
      QTimer::singleShot(0, this, [this] { revealControls(); });
    break;
  case QEvent::MouseButtonDblClick:
    if ((widget == video_ || widget == this) &&
        static_cast<QMouseEvent *>(event)->button() == Qt::LeftButton) {
      emit fullscreenRequested();
      return true;
    }
    break;
  case QEvent::KeyPress: {
    if (widget == controls_ || controls_->isAncestorOf(widget) ||
        static_cast<QKeyEvent *>(event)->key() == Qt::Key_Tab ||
        static_cast<QKeyEvent *>(event)->key() == Qt::Key_Backtab) {
      keyboardControls_ = true;
      showControls();
      idle_.stop();
    }
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
