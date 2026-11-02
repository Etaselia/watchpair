#include "seek_slider.h"
#include <QEvent>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QStyle>
#include <QStyleOptionSlider>

namespace wp::ui {
SeekSlider::SeekSlider(Qt::Orientation orientation, QWidget *parent) : QSlider(orientation, parent) {}

int SeekSlider::positionAt(const QPoint &point) const {
  QStyleOptionSlider option;
  initStyleOption(&option);
  const auto groove = style()->subControlRect(QStyle::CC_Slider, &option, QStyle::SC_SliderGroove, this);
  const auto handle = style()->subControlRect(QStyle::CC_Slider, &option, QStyle::SC_SliderHandle, this);
  const bool horizontal = orientation() == Qt::Horizontal;
  const int length = horizontal ? handle.width() : handle.height();
  const int start = horizontal ? groove.left() : groove.top();
  const int end = (horizontal ? groove.right() : groove.bottom()) - length + 1;
  const int pixel = (horizontal ? point.x() : point.y()) - length / 2;
  return QStyle::sliderValueFromPosition(minimum(), maximum(), pixel - start,
                                        qMax(0, end - start), option.upsideDown);
}

void SeekSlider::mousePressEvent(QMouseEvent *event) {
  if (event->button() != Qt::LeftButton || !isEnabled() || scrubbing_) {
    event->ignore();
    return;
  }
  if (focusPolicy() & Qt::ClickFocus)
    setFocus(Qt::MouseFocusReason);
  initialValue_ = value();
  scrubbing_ = true;
  // Capture the playback context before jumping to the pressed position.
  setSliderDown(true);
  setSliderPosition(positionAt(event->position().toPoint()));
  event->accept();
}

void SeekSlider::mouseMoveEvent(QMouseEvent *event) {
  if (!scrubbing_) {
    QSlider::mouseMoveEvent(event);
    return;
  }
  setSliderPosition(positionAt(event->position().toPoint()));
  event->accept();
}

void SeekSlider::mouseReleaseEvent(QMouseEvent *event) {
  if (!scrubbing_ || event->button() != Qt::LeftButton) {
    event->ignore();
    return;
  }
  const int position = positionAt(event->position().toPoint());
  scrubbing_ = false;
  // sliderReleased observers must see the final value even with tracking off.
  setValue(position);
  setSliderDown(false);
  event->accept();
}

void SeekSlider::cancelScrub() {
  if (!scrubbing_)
    return;
  scrubbing_ = false;
  emit scrubCancelled();
  setSliderPosition(initialValue_);
  setSliderDown(false);
}

bool SeekSlider::event(QEvent *event) {
  if (event->type() == QEvent::Hide || event->type() == QEvent::UngrabMouse ||
      event->type() == QEvent::WindowDeactivate ||
      (event->type() == QEvent::EnabledChange && !isEnabled()))
    cancelScrub();
  return QSlider::event(event);
}

void SeekSlider::keyPressEvent(QKeyEvent *event) {
  if (scrubbing_ && event->key() == Qt::Key_Escape) {
    cancelScrub();
    event->accept();
    return;
  }
  QSlider::keyPressEvent(event);
}
} // namespace wp::ui
