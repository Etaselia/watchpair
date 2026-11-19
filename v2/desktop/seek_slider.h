#pragma once
#include <QJsonArray>
#include <QSlider>
#include <optional>

namespace wp::ui {
class SeekSlider final : public QSlider {
  Q_OBJECT
public:
  explicit SeekSlider(Qt::Orientation orientation, QWidget *parent = nullptr);
  void setTimeline(double duration, const QJsonArray &chapters);
  void dismissPreview();
signals:
  void scrubCancelled();
  void previewPosition(double seconds, QString chapter, QPoint anchor, bool precise);
  void previewDismissed();
protected:
  bool event(QEvent *event) override;
  void paintEvent(QPaintEvent *event) override;
  void mousePressEvent(QMouseEvent *event) override;
  void mouseMoveEvent(QMouseEvent *event) override;
  void mouseReleaseEvent(QMouseEvent *event) override;
  void keyPressEvent(QKeyEvent *event) override;
private:
  struct Track {
    QRect groove;
    int start, span;
    bool inverted;
  };
  struct Chapter {
    double start;
    QString title;
  };
  Track track() const;
  int positionAt(const QPoint &point) const;
  int scrubPosition(const QMouseEvent &event);
  void showPreview(int position);
  void cancelScrub();
  QJsonArray chapterData_;
  QList<Chapter> chapters_;
  double duration_ = 0;
  bool scrubbing_ = false;
  int initialValue_ = 0;
  std::optional<QPoint> fineAnchor_;
  int fineValue_ = 0;
  bool previewVisible_ = false;
};
} // namespace wp::ui
