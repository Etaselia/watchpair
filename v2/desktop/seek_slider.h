#pragma once
#include <QSlider>

namespace wp::ui {
class SeekSlider final : public QSlider {
  Q_OBJECT
public:
  explicit SeekSlider(Qt::Orientation orientation, QWidget *parent = nullptr);
signals:
  void scrubCancelled();
protected:
  bool event(QEvent *event) override;
  void mousePressEvent(QMouseEvent *event) override;
  void mouseMoveEvent(QMouseEvent *event) override;
  void mouseReleaseEvent(QMouseEvent *event) override;
  void keyPressEvent(QKeyEvent *event) override;
private:
  int positionAt(const QPoint &point) const;
  void cancelScrub();
  bool scrubbing_ = false;
  int initialValue_ = 0;
};
} // namespace wp::ui
