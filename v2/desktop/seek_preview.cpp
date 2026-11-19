#include "seek_preview.h"
#include "library_service.h"
#include "ui_models.h"
#include <QElapsedTimer>
#include <QFileInfo>
#include <QLabel>
#include <QVBoxLayout>
#include <QtConcurrentRun>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <mpv/client.h>

namespace wp::ui {
namespace {
const QSize thumbnailSize(224, 126);

QImage frameImage(const mpv_node &result) {
  if (result.format != MPV_FORMAT_NODE_MAP)
    return {};
  qint64 width = 0, height = 0, stride = 0;
  const mpv_byte_array *pixels = nullptr;
  bool bgr0 = false;
  for (int i = 0; i < result.u.list->num; ++i) {
    const auto *key = result.u.list->keys[i];
    const auto &value = result.u.list->values[i];
    if (value.format == MPV_FORMAT_INT64) {
      if (!std::strcmp(key, "w"))
        width = value.u.int64;
      if (!std::strcmp(key, "h"))
        height = value.u.int64;
      if (!std::strcmp(key, "stride"))
        stride = value.u.int64;
    } else if (value.format == MPV_FORMAT_BYTE_ARRAY && !std::strcmp(key, "data")) {
      pixels = value.u.ba;
    } else if (value.format == MPV_FORMAT_STRING && !std::strcmp(key, "format")) {
      bgr0 = !std::strcmp(value.u.string, "bgr0");
    }
  }
  if (!bgr0 || !pixels || !pixels->data || width <= 0 || width > thumbnailSize.width() ||
      height <= 0 || height > thumbnailSize.height() || stride < width * 4 || stride > 4096 ||
      pixels->size < size_t((height - 1) * stride + width * 4))
    return {};
  QImage image(int(width), int(height), QImage::Format_RGB32);
  if (image.isNull())
    return {};
  for (int y = 0; y < image.height(); ++y) {
    const auto *source = static_cast<const uchar *>(pixels->data) + stride * y;
    auto *destination = reinterpret_cast<QRgb *>(image.scanLine(y));
    for (int x = 0; x < image.width(); ++x, source += 4)
      destination[x] = qRgb(source[2], source[1], source[0]);
  }
  return image;
}

QImage thumbnail(const QJsonObject &source, qint64 milliseconds, const std::atomic_bool &cancelled) {
  const QFileInfo file(source.value(QStringLiteral("path")).toString());
  if (cancelled || !file.isAbsolute() || !LibraryService::unchanged(source))
    return {};
  std::unique_ptr<mpv_handle, decltype(&mpv_terminate_destroy)> mpv(mpv_create(), mpv_terminate_destroy);
  if (!mpv)
    return {};
  // The preview only opens the completed local file. Disallow playlist
  // references, adjacent files, scripts and FFmpeg network protocols.
  const std::pair<const char *, const char *> options[] = {
      {"config", "no"}, {"terminal", "no"}, {"load-scripts", "no"}, {"access-references", "no"},
      {"autoload-files", "no"}, {"demuxer-lavf-o", "protocol_whitelist=file"},
      {"vo", "null"}, {"aid", "no"}, {"sid", "no"}, {"pause", "yes"}, {"keep-open", "yes"},
      {"cache", "no"}, {"hwdec", "no"}, {"vd-lavc-threads", "1"}, {"hr-seek", "always"},
      {"vf", "lavfi=[scale=224:126:force_original_aspect_ratio=decrease:force_divisible_by=2]"},
  };
  for (const auto &[key, value] : options)
    if (mpv_set_option_string(mpv.get(), key, value) < 0)
      return {};
  const auto start = QByteArray::number(milliseconds / 1000.0, 'f', 3);
  if (mpv_set_option_string(mpv.get(), "start", start.constData()) < 0 || mpv_initialize(mpv.get()) < 0)
    return {};
  const auto filename = file.absoluteFilePath().toUtf8();
  const char *load[] = {"loadfile", filename.constData(), "replace", nullptr};
  if (mpv_command_async(mpv.get(), 1, load) < 0)
    return {};
  QElapsedTimer deadline;
  deadline.start();
  bool requested = false;
  while (!cancelled && deadline.elapsed() < 1800) {
    const auto *event = mpv_wait_event(mpv.get(), 0.04);
    if (event->event_id == MPV_EVENT_END_FILE || event->event_id == MPV_EVENT_SHUTDOWN)
      return {};
    if (event->event_id == MPV_EVENT_PLAYBACK_RESTART && !requested) {
      // Ubuntu 24.04's libmpv provides the default BGR0 layout.
      const char *capture[] = {"screenshot-raw", "video", nullptr};
      if (mpv_command_async(mpv.get(), 2, capture) < 0)
        return {};
      requested = true;
    }
    if (event->event_id == MPV_EVENT_COMMAND_REPLY) {
      if (event->error < 0)
        return {};
      if (event->reply_userdata == 2 && event->data && LibraryService::unchanged(source))
        return frameImage(static_cast<const mpv_event_command *>(event->data)->result);
    }
  }
  return {};
}
} // namespace

SeekPreview::SeekPreview(QWidget *player) : QWidget(player) {
  setObjectName(QStringLiteral("SeekPreview"));
  setAttribute(Qt::WA_StyledBackground);
  setAttribute(Qt::WA_TransparentForMouseEvents);
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(8, 7, 8, 7);
  layout->setSpacing(3);
  thumbnail_ = new QLabel;
  thumbnail_->setObjectName(QStringLiteral("SeekThumbnail"));
  thumbnail_->setAlignment(Qt::AlignCenter);
  time_ = new QLabel;
  time_->setObjectName(QStringLiteral("SeekPreviewTime"));
  chapter_ = new QLabel;
  chapter_->setObjectName(QStringLiteral("SeekPreviewChapter"));
  for (auto *label : {time_, chapter_}) {
    label->setTextFormat(Qt::PlainText);
    label->setAlignment(Qt::AlignCenter);
  }
  layout->addWidget(thumbnail_);
  layout->addWidget(time_);
  layout->addWidget(chapter_);
  thumbnail_->hide();
  hide();

  pool_.setMaxThreadCount(1);
  delay_.setSingleShot(true);
  delay_.setInterval(110);
  connect(&delay_, &QTimer::timeout, this, &SeekPreview::decode);
  connect(&worker_, &QFutureWatcher<QImage>::finished, this, [this] {
    const auto image = worker_.result();
    const bool accepted = jobFile_ == file_ && cancelled_ && !*cancelled_;
    busy_ = false;
    cancelled_.reset();
    if (accepted) {
      cache_.insert(decoding_, new QImage(image));
      if (wanted_ == decoding_ && isVisible()) {
        setThumbnail(image);
        place();
      }
    }
    if (wanted_ >= 0 && !cache_.contains(wanted_) && !delay_.isActive())
      delay_.start();
  });
}

SeekPreview::~SeekPreview() {
  if (cancelled_)
    *cancelled_ = true;
}

void SeekPreview::setSource(const QJsonObject &file) {
  if (file_ == file)
    return;
  dismiss();
  cache_.clear();
  file_ = file;
}

void SeekPreview::showAt(double seconds, const QString &title, const QPoint &anchor, bool precise, double duration) {
  anchor_ = anchor;
  const auto tenths = qint64(std::floor(seconds * 10));
  time_->setText(precise ? tr("Fine scrub · %1.%2").arg(elapsed(tenths / 10)).arg(tenths % 10)
                         : elapsed(seconds));
  const int width = qMin(thumbnailSize.width(), qMax(1, parentWidget()->width() - 32));
  chapter_->setText(chapter_->fontMetrics().elidedText(title, Qt::ElideRight, width));
  chapter_->setVisible(!title.isEmpty());
  const auto sample = qint64(std::floor(std::min(seconds, std::max(0., duration - .15)) * 2)) * 500;
  const auto wanted = file_.isEmpty() ? -1 : sample;
  if (wanted_ != wanted) {
    wanted_ = wanted;
    if (const auto *cached = cache_.object(wanted_)) {
      setThumbnail(*cached);
      delay_.stop();
    } else if (wanted_ >= 0) {
      setThumbnail({});
      delay_.start();
    }
  }
  place();
  show();
  raise();
}

void SeekPreview::dismiss() {
  hide();
  thumbnail_->hide();
  wanted_ = -1;
  delay_.stop();
  if (cancelled_)
    *cancelled_ = true;
}

void SeekPreview::decode() {
  if (wanted_ < 0 || cache_.contains(wanted_) || !isVisible())
    return;
  if (busy_) {
    if (wanted_ != decoding_ && cancelled_)
      *cancelled_ = true;
    return;
  }
  busy_ = true;
  jobFile_ = file_;
  decoding_ = wanted_;
  cancelled_ = std::make_shared<std::atomic_bool>(false);
  worker_.setFuture(QtConcurrent::run(&pool_, [file = jobFile_, time = decoding_, cancelled = cancelled_] {
    return thumbnail(file, time, *cancelled);
  }));
}

void SeekPreview::setThumbnail(const QImage &image) {
  if (!image.isNull())
    thumbnail_->setPixmap(QPixmap::fromImage(image));
  else
    thumbnail_->clear();
  thumbnail_->setVisible(!image.isNull());
}

void SeekPreview::place() {
  adjustSize();
  const auto *player = parentWidget();
  move(qBound(0, anchor_.x() - width() / 2, qMax(0, player->width() - width())),
       qBound(0, anchor_.y() - height() - 6, qMax(0, player->height() - height())));
}
} // namespace wp::ui
