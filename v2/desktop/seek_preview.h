#pragma once
#include <QCache>
#include <QFutureWatcher>
#include <QImage>
#include <QJsonObject>
#include <QThreadPool>
#include <QTimer>
#include <QWidget>
#include <atomic>
#include <memory>

class QLabel;

namespace wp::ui {
class SeekPreview final : public QWidget {
  Q_OBJECT
public:
  explicit SeekPreview(QWidget *player);
  ~SeekPreview() override;
  void setSource(const QJsonObject &file);
  void showAt(double seconds, const QString &chapter, const QPoint &anchor, bool precise, double duration);
  void dismiss();

private:
  void decode();
  void setThumbnail(const QImage &image);
  void place();

  QLabel *thumbnail_, *time_, *chapter_;
  QJsonObject file_, jobFile_;
  QPoint anchor_;
  QCache<qint64, QImage> cache_{40};
  QThreadPool pool_;
  QFutureWatcher<QImage> worker_;
  QTimer delay_;
  std::shared_ptr<std::atomic_bool> cancelled_;
  qint64 wanted_ = -1, decoding_ = -1;
  bool busy_ = false;
};
} // namespace wp::ui
