#include "video_widget.h"
#include <QDebug>
#include <QMetaObject>
#include <QOpenGLContext>
#include <QOpenGLExtraFunctions>
#include <QOpenGLFunctions>
#include <QShowEvent>
#include <QWindow>
#include <array>

namespace wp {
namespace {
void traceFramebuffer(QOpenGLContext *context, const void *widget, GLuint framebuffer,
                      const QSize &size, const char *stage) {
  auto *gl = context->functions();
  auto *extra = context->extraFunctions();
  // Qt's wrapper redirects framebuffer zero to the widget's default FBO.
  // Diagnostics must restore the literal native binding left by libmpv.
  using BindFramebuffer = void (QOPENGLF_APIENTRY *)(GLenum, GLuint);
  const auto bindFramebuffer =
      reinterpret_cast<BindFramebuffer>(context->getProcAddress("glBindFramebuffer"));
  if (!bindFramebuffer)
    return;
  GLint previousRead = 0, previousDraw = 0, drawBuffer = 0, packBuffer = 0, readBuffer = 0;
  gl->glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previousRead);
  gl->glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &previousDraw);
  gl->glGetIntegerv(GL_DRAW_BUFFER0, &drawBuffer);
  gl->glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &packBuffer);
  constexpr std::array<GLenum, 4> packing{GL_PACK_ALIGNMENT, GL_PACK_ROW_LENGTH,
                                        GL_PACK_SKIP_ROWS, GL_PACK_SKIP_PIXELS};
  std::array<GLint, 4> previousPacking{};
  for (size_t i = 0; i < packing.size(); ++i) {
    gl->glGetIntegerv(packing[i], &previousPacking[i]);
    gl->glPixelStorei(packing[i], i == 0 ? 1 : 0);
  }
  extra->glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  bindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
  gl->glGetIntegerv(GL_READ_BUFFER, &readBuffer);
  extra->glReadBuffer(framebuffer ? GL_COLOR_ATTACHMENT0 : GL_BACK);
  std::array<unsigned char, 16> pixels{};
  for (int sample = 0; sample < 4; ++sample)
    gl->glReadPixels(size.width() * (sample % 2 ? 3 : 1) / 4,
                     size.height() * (sample / 2 ? 3 : 1) / 4, 1, 1, GL_RGBA,
                     GL_UNSIGNED_BYTE, pixels.data() + sample * 4);
  extra->glReadBuffer(GLenum(readBuffer));
  bindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(previousRead));
  extra->glBindBuffer(GL_PIXEL_PACK_BUFFER, GLuint(packBuffer));
  for (size_t i = 0; i < packing.size(); ++i)
    gl->glPixelStorei(packing[i], previousPacking[i]);
  qInfo().nospace() << "WatchPair GL pixels " << stage << " widget=" << widget
                    << " fbo=" << framebuffer << " size=" << size
                    << " previousReadFbo=" << previousRead << " drawFbo=" << previousDraw
                    << " readBuffer=" << readBuffer << " drawBuffer=" << drawBuffer
                    << " packBuffer=" << packBuffer << " packing=" << previousPacking[0] << ','
                    << previousPacking[1] << ',' << previousPacking[2] << ',' << previousPacking[3]
                    << " rgba="
                    << QByteArray(reinterpret_cast<const char *>(pixels.data()), pixels.size()).toHex();
}
} // namespace
VideoWidget::VideoWidget(Player &player, QWidget *parent) : QOpenGLWidget(parent), player_(player) {
  setMinimumSize(480, 270);
  setAutoFillBackground(false);
  setAttribute(Qt::WA_OpaquePaintEvent);
  // Qt can invalidate framebuffer contents during exposure or a framebuffer
  // grab even when the native frame has not changed. Keep its surface, but
  // redraw the cached native frame on every paintGL invocation.
  setUpdateBehavior(QOpenGLWidget::PartialUpdate);
  hiddenFrames_.setTimerType(Qt::PreciseTimer);
  connect(&hiddenFrames_, &QTimer::timeout, this, [this] {
    if (pendingFrame_.load())
      frameAvailable();
  });
  hiddenFrames_.start(16);
}
VideoWidget::~VideoWidget() {
  hiddenFrames_.stop();
  const bool debug = qEnvironmentVariableIsSet("WATCHPAIR_GL_DEBUG");
  if (debug)
    qInfo().nospace() << "WatchPair GL destroy widget=" << static_cast<const void *>(this)
                      << " context=" << static_cast<const void *>(context())
                      << " created=" << static_cast<const void *>(debugRenderContext_)
                      << " current=" << static_cast<const void *>(QOpenGLContext::currentContext())
                      << " render=" << static_cast<const void *>(render_);
  if (render_) {
    makeCurrent();
    if (debug)
      qInfo().nospace() << "WatchPair GL free widget=" << static_cast<const void *>(this)
                        << " current=" << static_cast<const void *>(QOpenGLContext::currentContext());
    softwareSurface_.reset();
    mpv_render_context_set_update_callback(render_, nullptr, nullptr);
    mpv_render_context_free(render_);
    render_ = nullptr;
    doneCurrent();
  }
}
void VideoWidget::initializeGL() {
  const bool debug = qEnvironmentVariableIsSet("WATCHPAIR_GL_DEBUG");
  if (debug) {
    debugPaints_ = debugVideoPaints_ = debugHiddenRenders_ = 0;
    qInfo().nospace() << "WatchPair GL initialize widget=" << static_cast<const void *>(this)
                      << " context=" << static_cast<const void *>(context())
                      << " current=" << static_cast<const void *>(QOpenGLContext::currentContext())
                      << " shareGroup=" << static_cast<const void *>(context()->shareGroup())
                      << " previousRender=" << static_cast<const void *>(render_);
    connect(context(), &QOpenGLContext::aboutToBeDestroyed, context(),
            [widget = static_cast<const void *>(this), created = static_cast<const void *>(context())] {
      qInfo().nospace() << "WatchPair GL context destroying widget=" << widget
                        << " context=" << created
                        << " current=" << static_cast<const void *>(QOpenGLContext::currentContext());
    });
  }
  const auto renderer =
      QByteArray(reinterpret_cast<const char *>(context()->functions()->glGetString(GL_RENDERER))).toLower();
  software_ = renderer.contains("softpipe") || renderer.contains("llvmpipe") ||
              renderer.contains("software rasterizer");
  if (software_) {
    // Keep tone mapping and subtitles, while avoiding the advanced multi-pass
    // scalers that can render black video on Mesa's CPU renderer.
    const auto code = mpv_set_property_string(player_.native(), "gpu-dumb-mode", "yes");
    if (code < 0) {
      const auto message = QString::fromUtf8(mpv_error_string(code));
      player_.rendererFailed(message);
      emit failure(message);
      return;
    }
  }
  context()->functions()->glGetIntegerv(GL_MAX_TEXTURE_IMAGE_UNITS, &textureUnits_);
  prepareGL();
  mpv_opengl_init_params gl{[](void *, const char *name) -> void * {
                              return reinterpret_cast<void *>(
                                  QOpenGLContext::currentContext()->getProcAddress(name));
                            },
                            nullptr};
  mpv_render_param params[] = {{MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL)},
                               {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
                               {MPV_RENDER_PARAM_INVALID, nullptr}};
  const auto result = mpv_render_context_create(&render_, player_.native(), params);
  if (debug) {
    if (result >= 0)
      debugRenderContext_ = QOpenGLContext::currentContext();
    qInfo().nospace() << "WatchPair GL created widget=" << static_cast<const void *>(this)
                      << " context=" << static_cast<const void *>(debugRenderContext_)
                      << " render=" << static_cast<const void *>(render_)
                      << " result=" << result << " renderer=" << renderer;
  }
  if (result < 0) {
    player_.rendererFailed(QString::fromUtf8(mpv_error_string(result)));
    emit failure(QString::fromUtf8(mpv_error_string(result)));
    return;
  }
  mpv_render_context_set_update_callback(
      render_,
      [](void *data) {
        auto *widget = static_cast<VideoWidget *>(data);
        // Coalesce wakeups while a software-rendered frame is still pending.
        // Otherwise decoder callbacks can flood the GUI event queue.
        if (!widget->pendingFrame_.exchange(true))
          QMetaObject::invokeMethod(widget, [widget] { widget->frameAvailable(); }, Qt::QueuedConnection);
      },
      this);
  player_.rendererReady();
}
void VideoWidget::showEvent(QShowEvent *event) {
  QOpenGLWidget::showEvent(event);
  update();
}
void VideoWidget::frameAvailable() {
  if (!render_)
    return;
  if (isVisible() && window()->windowHandle() && window()->windowHandle()->isExposed()) {
    update();
    return;
  }
  // A hidden transfer/library page must not stall the player's video queue.
  // libmpv still needs a current GL context when consuming an undisplayed frame.
  makeCurrent();
  pendingFrame_.store(false);
  prepareGL();
  if (mpv_render_context_update(render_) & MPV_RENDER_UPDATE_FRAME) {
    int skip = 1;
    mpv_render_param params[] = {{MPV_RENDER_PARAM_SKIP_RENDERING, &skip},
                                 {MPV_RENDER_PARAM_INVALID, nullptr}};
    if (qEnvironmentVariableIsSet("WATCHPAIR_GL_DEBUG") && debugHiddenRenders_++ < 4)
      qInfo().nospace() << "WatchPair GL hidden render widget=" << static_cast<const void *>(this)
                        << " context=" << static_cast<const void *>(context())
                        << " created=" << static_cast<const void *>(debugRenderContext_)
                        << " current=" << static_cast<const void *>(QOpenGLContext::currentContext());
    mpv_render_context_render(render_, params);
  }
  doneCurrent();
}
void VideoWidget::prepareGL() {
  auto *gl = context()->functions();
  auto *extra = context()->extraFunctions();
  const bool debug = qEnvironmentVariableIsSet("WATCHPAIR_GL_DEBUG");
  // Qt's compositor also uses this context. Attribute errors to the render
  // operation that produced them, rather than inheriting its pending flags.
  for (int n = 0; n < 16 && gl->glGetError() != GL_NO_ERROR; ++n) {
  }
  auto check = [gl, debug](const char *stage) {
    if (debug) {
      const auto code = gl->glGetError();
      if (code)
        qWarning("OpenGL boundary %s: %u", stage, code);
    }
  };
  // Sampler objects and upload offsets left by Qt override texture parameters
  // even when libmpv binds its own textures. Reset the documented API boundary.
  for (int unit = 0; unit < textureUnits_; ++unit) {
    gl->glActiveTexture(GL_TEXTURE0 + unit);
    gl->glBindTexture(GL_TEXTURE_2D, 0);
    extra->glBindSampler(unit, 0);
  }
  gl->glActiveTexture(GL_TEXTURE0);
  check("samplers");
  extra->glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
  gl->glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
  gl->glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
  gl->glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
  gl->glPixelStorei(GL_UNPACK_IMAGE_HEIGHT, 0);
  gl->glPixelStorei(GL_UNPACK_SKIP_IMAGES, 0);
  gl->glPixelStorei(GL_UNPACK_SWAP_BYTES, GL_FALSE);
  gl->glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  check("pixel upload");
  extra->glBindVertexArray(0);
  gl->glUseProgram(0);
  gl->glDisable(GL_SCISSOR_TEST);
  gl->glDisable(GL_BLEND);
  // Qt's compositor can leave clipping/depth state enabled. libmpv's render
  // API requires standard defaults, including after framebuffer grabs.
  gl->glDisable(GL_STENCIL_TEST);
  gl->glDisable(GL_DEPTH_TEST);
  gl->glDisable(GL_CULL_FACE);
  gl->glDisable(GL_RASTERIZER_DISCARD);
  gl->glDisable(GL_SAMPLE_ALPHA_TO_COVERAGE);
  gl->glDisable(GL_SAMPLE_COVERAGE);
  gl->glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  check("draw defaults");
}
void VideoWidget::paintGL() {
  if (!render_)
    return;
  pendingFrame_.store(false);
  prepareGL();
  const auto updates = mpv_render_context_update(render_);
  const QSize target(qRound(width() * devicePixelRatioF()), qRound(height() * devicePixelRatioF()));
  auto *gl = context()->functions();
  const auto renderSize = software_ && (target.width() > 640 || target.height() > 360)
                              ? target.scaled(QSize(640, 360), Qt::KeepAspectRatio)
                              : target;
  if (renderSize != target && (!softwareSurface_ || softwareSurface_->size() != renderSize)) {
    softwareSurface_ = std::make_unique<QOpenGLFramebufferObject>(renderSize);
    if (!softwareSurface_->isValid()) {
      emit failure(QStringLiteral("Could not allocate the software graphics preview."));
      return;
    }
    prepareGL();
  }
  const auto framebuffer = renderSize == target ? defaultFramebufferObject() : softwareSurface_->handle();
  context()->extraFunctions()->glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
  const GLenum drawBuffer = GL_COLOR_ATTACHMENT0;
  context()->extraFunctions()->glDrawBuffers(1, &drawBuffer);
  if (updates & MPV_RENDER_UPDATE_FRAME)
    ++frames_;
  mpv_opengl_fbo fbo{static_cast<int>(framebuffer), renderSize.width(), renderSize.height(), 0};
  int flip = 1;
  mpv_render_param params[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
                               {MPV_RENDER_PARAM_FLIP_Y, &flip},
                               {MPV_RENDER_PARAM_INVALID, nullptr}};
  const bool debugVideo = player_.loaded() && player_.sampledPosition() > .5;
  const bool debug = qEnvironmentVariableIsSet("WATCHPAIR_GL_DEBUG") &&
                     (debugPaints_++ < 3 || (debugVideo && debugVideoPaints_++ < 6));
  if (debug)
    qInfo().nospace() << "WatchPair GL paint begin widget=" << static_cast<const void *>(this)
                      << " context=" << static_cast<const void *>(context())
                      << " created=" << static_cast<const void *>(debugRenderContext_)
                      << " current=" << static_cast<const void *>(QOpenGLContext::currentContext())
                      << " target=" << target << " renderSize=" << renderSize
                      << " fbo=" << framebuffer << " defaultFbo=" << defaultFramebufferObject()
                      << " complete=" << (gl->glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE)
                      << " software=" << software_ << " updates=" << updates
                      << " draws=" << draws_ << " frames=" << frames_
                      << " position=" << player_.sampledPosition();
  const auto result = mpv_render_context_render(render_, params);
  if (debug)
    qInfo().nospace() << "WatchPair GL paint end widget=" << static_cast<const void *>(this)
                      << " result=" << result;
  if (debug && debugVideo)
    traceFramebuffer(context(), this, framebuffer, renderSize, "mpv-output");
  if (renderSize != target) {
    auto *extra = context()->extraFunctions();
    extra->glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
    extra->glBindFramebuffer(GL_DRAW_FRAMEBUFFER, defaultFramebufferObject());
    extra->glBlitFramebuffer(0, 0, renderSize.width(), renderSize.height(), 0, 0, target.width(),
                             target.height(), GL_COLOR_BUFFER_BIT, GL_LINEAR);
    extra->glBindFramebuffer(GL_FRAMEBUFFER, defaultFramebufferObject());
  }
  if (debug && debugVideo)
    traceFramebuffer(context(), this, defaultFramebufferObject(), target, "qt-output");
  ++draws_;
  glError_ = int(gl->glGetError());
  if (result < 0)
    emit failure(QString::fromUtf8(mpv_error_string(result)));
}
} // namespace wp
