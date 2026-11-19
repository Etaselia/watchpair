#include "seek_slider.h"
#include <algorithm>
#include <cmath>
#include <QEnterEvent>
#include <QEvent>
#include <QJsonObject>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QPainterPath>
#include <QStyle>
#include <QStyleOptionSlider>
#include <QStylePainter>

namespace wp::ui {
SeekSlider::SeekSlider(Qt::Orientation orientation, QWidget *parent) : QSlider(orientation, parent) {
  setMouseTracking(true);
}

void SeekSlider::setTimeline(double duration, const QJsonArray &chapters) {
  if (!std::isfinite(duration) || duration <= 0)
    duration = 0;
  if (duration_ == duration && chapterData_ == chapters)
    return;
  dismissPreview();
  duration_ = duration;
  chapterData_ = chapters;
  chapters_.clear();
  for (const auto &value : chapters) {
    const auto chapter = value.toObject();
    const auto start = chapter.value(QStringLiteral("time")).toDouble(-1);
    if (std::isfinite(start) && start >= 0 && start < duration_)
      chapters_.append({start, chapter.value(QStringLiteral("title")).toString().simplified()});
  }
  std::stable_sort(chapters_.begin(), chapters_.end(), [](const auto &a, const auto &b) {
    return a.start < b.start;
  });
  for (qsizetype i = 0; i < chapters_.size(); ++i)
    if (chapters_[i].title.isEmpty())
      chapters_[i].title = tr("Chapter %1").arg(i + 1);
  update();
}

SeekSlider::Track SeekSlider::track() const {
  QStyleOptionSlider option;
  initStyleOption(&option);
  const auto groove = style()->subControlRect(QStyle::CC_Slider, &option, QStyle::SC_SliderGroove, this);
  const auto handle = style()->subControlRect(QStyle::CC_Slider, &option, QStyle::SC_SliderHandle, this);
  const bool horizontal = orientation() == Qt::Horizontal;
  const int length = horizontal ? handle.width() : handle.height();
  const int start = horizontal ? groove.left() : groove.top();
  const int end = (horizontal ? groove.right() : groove.bottom()) - length + 1;
  return {groove, start + length / 2, qMax(0, end - start), option.upsideDown};
}

int SeekSlider::positionAt(const QPoint &point) const {
  const auto axis = track();
  const int pixel = orientation() == Qt::Horizontal ? point.x() : point.y();
  return QStyle::sliderValueFromPosition(minimum(), maximum(), pixel - axis.start, axis.span, axis.inverted);
}

int SeekSlider::scrubPosition(const QMouseEvent &event) {
  const auto point = event.position().toPoint();
  if (orientation() != Qt::Horizontal)
    return positionAt(point);
  if (!fineAnchor_ && (point.y() <= -18 || event.modifiers().testFlag(Qt::ShiftModifier))) {
    fineAnchor_ = point;
    fineValue_ = sliderPosition();
  }
  if (!fineAnchor_)
    return positionAt(point);
  const auto axis = track();
  const double direction = axis.inverted ? -1 : 1;
  const double delta = direction * (double(point.x()) - fineAnchor_->x()) *
      (double(maximum()) - minimum()) / (16 * qMax(1, axis.span));
  return qRound(std::clamp(fineValue_ + delta, double(minimum()), double(maximum())));
}

void SeekSlider::showPreview(int position) {
  if (!isVisible() || !isEnabled() || duration_ <= 0 || orientation() != Qt::Horizontal || maximum() <= minimum())
    return;
  const auto axis = track();
  const auto seconds = (double(position) - minimum()) / (double(maximum()) - minimum()) * duration_;
  const auto current = std::upper_bound(chapters_.cbegin(), chapters_.cend(), seconds,
                                        [](double at, const Chapter &chapter) { return at < chapter.start; });
  const auto chapter = current == chapters_.cbegin() ? QString() : std::prev(current)->title;
  const auto x = axis.start + QStyle::sliderPositionFromValue(minimum(), maximum(), position, axis.span, axis.inverted);
  previewVisible_ = true;
  emit previewPosition(seconds, chapter, {x, 0}, fineAnchor_.has_value());
}

void SeekSlider::dismissPreview() {
  if (previewVisible_) {
    previewVisible_ = false;
    emit previewDismissed();
  }
}

void SeekSlider::paintEvent(QPaintEvent *event) {
  const auto axis = track();
  if (chapters_.isEmpty() || axis.span <= 0 || orientation() != Qt::Horizontal) {
    QSlider::paintEvent(event);
    return;
  }
  QList<int> edges{0, axis.span};
  for (const auto &chapter : chapters_)
    edges.append(qRound(chapter.start / duration_ * axis.span));
  std::sort(edges.begin(), edges.end());
  edges.erase(std::unique(edges.begin(), edges.end()), edges.end());
  const int progress = QStyle::sliderPositionFromValue(minimum(), maximum(), sliderPosition(), axis.span);
  QStylePainter painter(this);
  painter.setRenderHint(QPainter::Antialiasing);
  const auto colors = isEnabled() ? QPalette::Active : QPalette::Disabled;
  const auto base = palette().color(colors, QPalette::Button).lighter(165);
  const auto played = palette().color(colors, QPalette::Highlight).lighter(175);
  const auto pixel = [&](int x) { return axis.start + (axis.inverted ? axis.span - x : x); };
  const auto height = qMax(5, axis.groove.height());
  const auto top = axis.groove.y() + (axis.groove.height() - height) / 2.0;
  for (qsizetype i = 1; i < edges.size(); ++i) {
    const qreal a = pixel(edges[i - 1]), b = pixel(edges[i]);
    QRectF segment{qMin(a, b), top, qAbs(b - a), qreal(height)};
    // Reserve a seam only if enough of this chapter will still be visible.
    if (segment.width() > 4)
      segment.adjust(1, 0, -1, 0);
    QPainterPath clip;
    clip.addRoundedRect(segment, 2, 2);
    painter.fillPath(clip, base);
    if (progress > edges[i - 1]) {
      painter.save();
      painter.setClipPath(clip);
      const auto end = pixel(qMin(progress, edges[i]));
      painter.fillRect(QRectF(qMin(a, qreal(end)), top, qAbs(a - end), height), played);
      painter.restore();
    }
  }
  QStyleOptionSlider option;
  initStyleOption(&option);
  option.subControls = QStyle::SC_SliderHandle;
  painter.drawComplexControl(QStyle::CC_Slider, option);
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
  fineAnchor_.reset();
  // Capture the playback context before jumping to the pressed position.
  setSliderDown(true);
  setSliderPosition(positionAt(event->position().toPoint()));
  showPreview(sliderPosition());
  event->accept();
}

void SeekSlider::mouseMoveEvent(QMouseEvent *event) {
  if (!scrubbing_) {
    QSlider::mouseMoveEvent(event);
    showPreview(positionAt(event->position().toPoint()));
    return;
  }
  setSliderPosition(scrubPosition(*event));
  showPreview(sliderPosition());
  event->accept();
}

void SeekSlider::mouseReleaseEvent(QMouseEvent *event) {
  if (!scrubbing_ || event->button() != Qt::LeftButton) {
    event->ignore();
    return;
  }
  const int position = scrubPosition(*event);
  scrubbing_ = false;
  fineAnchor_.reset();
  // sliderReleased observers must see the final value even with tracking off.
  setValue(position);
  setSliderDown(false);
  if (rect().contains(event->position().toPoint()))
    showPreview(position);
  else
    dismissPreview();
  event->accept();
}

void SeekSlider::cancelScrub() {
  if (!scrubbing_)
    return;
  scrubbing_ = false;
  fineAnchor_.reset();
  dismissPreview();
  emit scrubCancelled();
  setSliderPosition(initialValue_);
  setSliderDown(false);
}

bool SeekSlider::event(QEvent *event) {
  if (event->type() == QEvent::Enter)
    showPreview(positionAt(static_cast<QEnterEvent *>(event)->position().toPoint()));
  if (event->type() == QEvent::Leave && !scrubbing_)
    dismissPreview();
  if (event->type() == QEvent::Hide || event->type() == QEvent::UngrabMouse ||
      event->type() == QEvent::WindowDeactivate ||
      (event->type() == QEvent::EnabledChange && !isEnabled())) {
    cancelScrub();
    dismissPreview();
  }
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
