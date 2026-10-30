#pragma once
#include "player.h"
#include <QOpenGLFramebufferObject>
#include <QOpenGLWidget>
#include <atomic>
#include <memory>
#include <mpv/render_gl.h>
namespace wp {
class VideoWidget final : public QOpenGLWidget {
  Q_OBJECT
public:
  explicit VideoWidget(Player &player, QWidget *parent = nullptr);
  ~VideoWidget() override;
  bool rendering() const { return render_ != nullptr; }
  int draws() const { return draws_; }
  int frames() const { return frames_; }
  int glError() const { return glError_; }
  bool softwareGraphics() const { return software_; }
signals:
  void failure(QString message);

protected:
  void showEvent(QShowEvent *event) override;
  void initializeGL() override;
  void paintGL() override;

private:
  void frameAvailable();
  void prepareGL();
  Player &player_;
  mpv_render_context *render_ = nullptr;
  int draws_ = 0;
  int frames_ = 0, glError_ = 0;
  int textureUnits_ = 0;
  bool software_ = false;
  const QOpenGLContext *debugRenderContext_ = nullptr;
  int debugPaints_ = 0, debugVideoPaints_ = 0, debugHiddenRenders_ = 0;
  std::unique_ptr<QOpenGLFramebufferObject> softwareSurface_;
  QTimer hiddenFrames_;
  std::atomic_bool pendingFrame_{false};
};
} // namespace wp
