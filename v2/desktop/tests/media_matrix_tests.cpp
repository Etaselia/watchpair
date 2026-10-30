#include "library_service.h"
#include "native_runtime.h"
#include "player.h"
#include "verified_stream.h"
#include "video_widget.h"
#include <QApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QRectF>
#include <QScopeGuard>
#include <QSurfaceFormat>
#include <QtTest>

namespace {
QJsonObject descriptor(const QString &path) {
  QFile f(path);
  if (!f.open(QIODevice::ReadOnly))
    throw std::runtime_error("Generate the media matrix fixtures first");
  QCryptographicHash hash(QCryptographicHash::Sha256);
  hash.addData(&f);
  const QFileInfo info(path);
  return {{QStringLiteral("path"), info.canonicalFilePath()},
          {QStringLiteral("size"), info.size()},
          {QStringLiteral("mtime"), info.lastModified().toMSecsSinceEpoch()},
          {QStringLiteral("sha256"), QString::fromLatin1(hash.result().toHex())}};
}
int changedPixels(const QImage &a, const QImage &b) {
  if (a.size() != b.size())
    return 0;
  int result = 0;
  for (int y = a.height() / 2; y < a.height(); ++y)
    for (int x = 0; x < a.width(); ++x) {
      const QColor left(a.pixel(x, y)), right(b.pixel(x, y));
      if (std::abs(left.red() - right.red()) + std::abs(left.green() - right.green()) +
              std::abs(left.blue() - right.blue()) >
          90)
        ++result;
    }
  return result;
}
int videoColors(const QImage &image) {
  QSet<QRgb> distinct;
  // Subtitle antialiasing can contain many colors over otherwise black
  // video. Check the fixture's upper video area independently of text.
  for (int y = 0; y < image.height() / 2; y += 12)
    for (int x = 0; x < image.width(); x += 12)
      distinct.insert(image.pixel(x, y));
  return distinct.size();
}
class NativeProperties {
public:
  explicit NativeProperties(wp::Player &player)
      : client_(mpv_create_client(player.native(), "media-test"), mpv_destroy) {
    if (!client_)
      throw std::runtime_error("Cannot create the media test observer");
    quint64 id = 0;
    for (const auto *name : {"sid", "sub-text", "sub-visibility", "sub-delay", "sub-start", "sub-end"})
      if (mpv_observe_property(client_.get(), ++id, name, MPV_FORMAT_STRING) < 0)
        throw std::runtime_error("Cannot observe native subtitle state");
  }
  QString value(const char *name) {
    // A separate client keeps fresh property events independent of Player's
    // event consumer. Never block the GUI/render thread with a property getter.
    for (auto *event = mpv_wait_event(client_.get(), 0); event->event_id != MPV_EVENT_NONE;
         event = mpv_wait_event(client_.get(), 0)) {
      if (event->event_id != MPV_EVENT_PROPERTY_CHANGE)
        continue;
      const auto *property = static_cast<mpv_event_property *>(event->data);
      if (!property || !property->name)
        continue;
      const auto text = property->format == MPV_FORMAT_STRING && property->data
                            ? QString::fromUtf8(*static_cast<char **>(property->data))
                            : QStringLiteral("<unavailable>");
      values_.insert(QString::fromUtf8(property->name), text);
    }
    return values_.value(QString::fromLatin1(name), QStringLiteral("<unavailable>"));
  }

private:
  std::unique_ptr<mpv_handle, decltype(&mpv_destroy)> client_;
  QHash<QString, QString> values_;
};
int fixtureSubtitlePixels(const QImage &image, bool bitmap) {
  // generate-media-fixtures.py creates yellow ASS text near bottom center and
  // a white PGS rectangle at (24,140), size 96x16, in a 320x180 canvas. These
  // interior regions exclude the video's yellow bar and gray moving block.
  const QRectF region = bitmap ? QRectF(.10, .79, .25, .06) : QRectF(.55, .80, .40, .14);
  int result = 0;
  for (int y = int(region.top() * image.height()); y < int(region.bottom() * image.height()); ++y)
    for (int x = int(region.left() * image.width()); x < int(region.right() * image.width()); ++x) {
      const auto color = image.pixelColor(x, y);
      if (color.red() > (bitmap ? 220 : 200) && color.green() > (bitmap ? 220 : 200) &&
          (bitmap ? color.blue() > 220 : color.blue() < 70))
        ++result;
    }
  return result;
}
} // namespace
class MediaMatrix final : public QObject {
  Q_OBJECT
private slots:
  void systemAudioDriverOpensAtZeroVolume() {
    if (!qEnvironmentVariableIsSet("WATCHPAIR_TEST_REAL_AUDIO"))
      QSKIP("Set WATCHPAIR_TEST_REAL_AUDIO to verify an actual system audio backend");
    const auto fixtures = qEnvironmentVariable("WATCHPAIR_MEDIA_FIXTURES");
    QVERIFY(!fixtures.isEmpty());
    wp::Player player(nullptr, false, false);
    player.setVolume(0);
    wp::VideoWidget video(player);
    video.resize(640, 360);
    video.show();
    QVERIFY(QTest::qWaitForWindowExposed(&video));
    player.open(QUrl::fromLocalFile(QDir(fixtures).filePath(QStringLiteral("tracks.mkv"))));
    QTRY_VERIFY_WITH_TIMEOUT(player.loaded(), 10000);
    auto output = [&] {
      auto *value = mpv_get_property_string(player.native(), "current-ao");
      const auto result = value ? QString::fromUtf8(value) : QString();
      mpv_free(value);
      return result;
    };
    QTRY_VERIFY2_WITH_TIMEOUT(!output().isEmpty() && output() != QStringLiteral("null"),
                              "No real system audio driver opened", 10000);
    qInfo().noquote() << "Real audio backend:" << output();
    QTRY_VERIFY_WITH_TIMEOUT(player.sampledPosition() > .2, 5000);
    player.stop();
  }
  void nativeDecodeAndRendering_data() {
    QTest::addColumn<QString>("name");
    for (const auto *name : {"h264.mp4", "hevc10.mkv", "av1.mkv", "hdr-pq.mkv", "tracks.mkv"})
      QTest::newRow(name) << QString::fromLatin1(name);
  }
  void nativeDecodeAndRendering() {
    QFETCH(QString, name);
    const auto fixtures = QString::fromLocal8Bit(qgetenv("WATCHPAIR_MEDIA_FIXTURES"));
    QVERIFY2(!fixtures.isEmpty(), "Set WATCHPAIR_MEDIA_FIXTURES to the generated fixture directory");
    const auto output = QString::fromLocal8Bit(qgetenv("WATCHPAIR_MEDIA_OUTPUT"));
    wp::Player player(nullptr, false, true);
    NativeProperties observed(player);
    if (qEnvironmentVariableIsSet("WATCHPAIR_MEDIA_DISABLE_SHADER_CACHE"))
      QCOMPARE(mpv_set_property_string(player.native(), "gpu-shader-cache", "no"), 0);
    if (qEnvironmentVariableIsSet("WATCHPAIR_MEDIA_GPU_DUMB"))
      QCOMPARE(mpv_set_property_string(player.native(), "gpu-dumb-mode", "yes"), 0);
    const bool decodeControl = qEnvironmentVariableIsSet("WATCHPAIR_MEDIA_DECODE_CONTROL");
    if (decodeControl)
      QCOMPARE(mpv_set_property_string(player.native(), "screenshot-sw", "yes"), 0);
    // Readers must close before the renderer is destroyed: a native stop can
    // otherwise wait for an HTTP read while render-context teardown blocks.
    wp::VideoWidget video(player);
    if (qEnvironmentVariableIsSet("WATCHPAIR_MEDIA_TRACE"))
      connect(&player, &wp::Player::activity, this,
              [](const QString &message) { qInfo().noquote() << message; });
    const auto capture = qScopeGuard([&] {
      if (output.isEmpty())
        return;
      video.grabFramebuffer().save(QDir(output).filePath(name + QStringLiteral(".last.png")));
      QFile state(QDir(output).filePath(name + QStringLiteral(".last.json")));
      if (state.open(QIODevice::WriteOnly))
        state.write(QJsonDocument(QJsonObject{{QStringLiteral("media"), player.mediaInfo()},
                                              {QStringLiteral("position"), player.sampledPosition()},
                                              {QStringLiteral("paused"), player.paused()},
                                              {QStringLiteral("frames"), video.frames()},
                                              {QStringLiteral("draws"), video.draws()},
                                              {QStringLiteral("error"), player.error()}})
                        .toJson());
    });
    video.resize(640, 360);
    video.show();
    QVERIFY(QTest::qWaitForWindowExposed(&video));
    if (video.softwareGraphics()) {
      auto *nativeMode = mpv_get_property_string(player.native(), "gpu-dumb-mode");
      const auto mode = QString::fromUtf8(nativeMode ? nativeMode : "");
      mpv_free(nativeMode);
      QCOMPARE(mode, QStringLiteral("yes"));
    }
    wp::LocalFileSource local(descriptor(QDir(fixtures).filePath(name)));
    auto stream = std::make_unique<wp::VerifiedStream>(local);
    player.open(stream->url(0), false);
    QTRY_VERIFY2_WITH_TIMEOUT(player.loaded() && player.sampledPosition() > .5, qPrintable(player.error()),
                              10000);
    QTRY_VERIFY_WITH_TIMEOUT(video.frames() >= 3, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(player.mediaInfo().value(QStringLiteral("video")).isObject(), 3000);
    QCOMPARE(video.glError(), 0);
    if (decodeControl) {
      QVERIFY(!output.isEmpty());
      const auto path = QDir(output).filePath(name + QStringLiteral(".decoded.png"));
      const auto encoded = path.toUtf8();
      const char *args[] = {"screenshot-to-file", encoded.constData(), "video", nullptr};
      QCOMPARE(mpv_command_async(player.native(), 0, args), 0);
      QImage decoded;
      QTRY_VERIFY_WITH_TIMEOUT(decoded.load(path), 5000);
      qInfo().nospace() << "Decoded screenshot size=" << decoded.size()
                        << " upperColors=" << videoColors(decoded)
                        << " position=" << player.sampledPosition();
    }
    auto image = video.grabFramebuffer();
    auto colors = [&] {
      image = video.grabFramebuffer();
      return videoColors(image);
    };
    QTRY_VERIFY_WITH_TIMEOUT(colors() > 20, 6000);
    QVERIFY2(player.error().isEmpty(), qPrintable(player.error()));
    if (name == QStringLiteral("hdr-pq.mkv")) {
      const auto params = player.mediaInfo().value(QStringLiteral("video")).toObject();
      QCOMPARE(params.value(QStringLiteral("primaries")).toString(), QStringLiteral("bt.2020"));
      QCOMPARE(params.value(QStringLiteral("gamma")).toString(), QStringLiteral("pq"));
    }
    if (name == QStringLiteral("tracks.mkv")) {
      QTRY_COMPARE_WITH_TIMEOUT(player.chapters().size(), 2, 3000);
      QTRY_COMPARE_WITH_TIMEOUT(player.tracks().size(), 4, 3000);
      QString ass, pgs, stereo, surround;
      int assId = -1, pgsId = -1;
      for (auto value : player.tracks()) {
        const auto t = value.toObject();
        const auto codec = t.value(QStringLiteral("codec")).toString();
        if (codec == QStringLiteral("ass")) {
          ass = t.value(QStringLiteral("key")).toString();
          assId = t.value(QStringLiteral("id")).toInt();
        } else if (codec == QStringLiteral("hdmv_pgs_subtitle")) {
          pgs = t.value(QStringLiteral("key")).toString();
          pgsId = t.value(QStringLiteral("id")).toInt();
        } else if (t.value(QStringLiteral("type")).toString() == QStringLiteral("audio")) {
          if (t.value(QStringLiteral("channels")).toInt() == 6)
            surround = t.value(QStringLiteral("key")).toString();
          else
            stereo = t.value(QStringLiteral("key")).toString();
        }
      }
      QVERIFY(!ass.isEmpty() && !pgs.isEmpty() && !surround.isEmpty() && !stereo.isEmpty());
      const auto subtitleDiagnostic = [&](const QString &name) {
        if (!qEnvironmentVariableIsSet("WATCHPAIR_MEDIA_SUBTITLE_DIAGNOSTICS"))
          return;
        const auto inspect = [&](const QString &phase) {
          QJsonObject state;
          for (const auto *property :
               {"sid", "sub-text", "sub-visibility", "sub-delay", "sub-start", "sub-end"}) {
            state.insert(QString::fromLatin1(property), observed.value(property));
          }
          state.insert(QStringLiteral("position"), player.sampledPosition());
          state.insert(QStringLiteral("frames"), qint64(video.frames()));
          state.insert(QStringLiteral("draws"), qint64(video.draws()));
          qInfo().noquote() << name << phase << QJsonDocument(state).toJson(QJsonDocument::Compact);
          if (!output.isEmpty())
            video.grabFramebuffer().save(
                QDir(output).filePath(name + QLatin1Char('-') + phase + QStringLiteral(".png")));
        };
        inspect(QStringLiteral("immediate"));
        QTest::qWait(750);
        inspect(QStringLiteral("settled"));
      };
      player.setPaused(true);
      QTRY_VERIFY_WITH_TIMEOUT(player.paused(), 3000);
      player.seek(1.5);
      QTRY_VERIFY_WITH_TIMEOUT(!player.seeking() && std::abs(player.sampledPosition() - 1.5) < .001, 5000);
      const auto beforeOff = video.frames();
      const bool alreadyOff = player.mediaInfo().value(QStringLiteral("subtitleId")).isBool();
      QVERIFY(player.setTracks(surround, QStringLiteral("off"), 0));
      QTRY_COMPARE_WITH_TIMEOUT(observed.value("sid"), QStringLiteral("no"), 3000);
      QTRY_VERIFY_WITH_TIMEOUT(alreadyOff || video.frames() > beforeOff, 3000);
      QTRY_COMPARE_WITH_TIMEOUT(player.mediaInfo()
                                    .value(QStringLiteral("audio"))
                                    .toObject()
                                    .value(QStringLiteral("channel-count"))
                                    .toInt(),
                                6, 3000);
      // Audio selection can still be completing its asynchronous refresh. Take
      // the off baseline only after a new rendered frame at the exact seek PTS.
      const auto beforeClean = video.frames();
      player.seek(1.5);
      QTRY_VERIFY_WITH_TIMEOUT(player.paused() && !player.seeking() &&
                                   std::abs(player.sampledPosition() - 1.5) < .001 &&
                                   video.frames() > beforeClean,
                               5000);
      const auto clean = video.grabFramebuffer();
      QCOMPARE(fixtureSubtitlePixels(clean, false), 0);
      QCOMPARE(fixtureSubtitlePixels(clean, true), 0);
      if (!output.isEmpty())
        clean.save(QDir(output).filePath(QStringLiteral("subtitles-off.png")));
      subtitleDiagnostic(QStringLiteral("subtitles-off"));
      QImage subtitleImage;
      const auto renderedCaption = [&](bool bitmap) {
        subtitleImage = video.grabFramebuffer();
        const int minimumPixels = subtitleImage.width() * subtitleImage.height() / (bitmap ? 100 : 1000);
        return player.paused() && !player.seeking() && std::abs(player.sampledPosition() - 1.5) < .001 &&
               fixtureSubtitlePixels(subtitleImage, bitmap) > minimumPixels &&
               changedPixels(clean, subtitleImage) > 100;
      };
      QVERIFY(player.setTracks(surround, ass, 0));
      QTRY_COMPARE_WITH_TIMEOUT(observed.value("sid"), QString::number(assId), 3000);
      QTRY_COMPARE_WITH_TIMEOUT(observed.value("sub-text"), QStringLiteral("WatchPair ASS fixture"), 3000);
      QTRY_VERIFY2_WITH_TIMEOUT(
          renderedCaption(false),
          qPrintable(QStringLiteral("ASS redraw: frames=%1 draws=%2 position=%3 error=%4")
                         .arg(video.frames())
                         .arg(video.draws())
                         .arg(player.sampledPosition())
                         .arg(player.error())),
          3000);
      qInfo() << "ASS rendered pixels:" << fixtureSubtitlePixels(subtitleImage, false)
              << "paused PTS:" << player.sampledPosition();
      subtitleDiagnostic(QStringLiteral("ass"));
      if (!output.isEmpty())
        subtitleImage.save(QDir(output).filePath(QStringLiteral("ass.png")));
      QVERIFY(player.setTracks(stereo, pgs, .1));
      QTRY_COMPARE_WITH_TIMEOUT(observed.value("sid"), QString::number(pgsId), 3000);
      QTRY_VERIFY_WITH_TIMEOUT(renderedCaption(true), 3000);
      qInfo() << "PGS rendered pixels:" << fixtureSubtitlePixels(subtitleImage, true)
              << "paused PTS:" << player.sampledPosition();
      subtitleDiagnostic(QStringLiteral("pgs"));
      if (!output.isEmpty())
        subtitleImage.save(QDir(output).filePath(QStringLiteral("pgs.png")));
    }
    player.seek(4);
    player.setPaused(false);
    QTRY_VERIFY_WITH_TIMEOUT(!player.seeking() && player.sampledPosition() >= 4, 5000);
    if (!output.isEmpty()) {
      QDir().mkpath(output);
      image.save(QDir(output).filePath(name + QStringLiteral(".png")));
      QFile report(QDir(output).filePath(name + QStringLiteral(".json")));
      QVERIFY(report.open(QIODevice::WriteOnly));
      report.write(QJsonDocument(QJsonObject{{QStringLiteral("media"), player.mediaInfo()},
                                             {QStringLiteral("tracks"), player.tracks()},
                                             {QStringLiteral("chapters"), player.chapters()},
                                             {QStringLiteral("frames"), video.frames()}})
                       .toJson());
    }
    player.stop();
    stream.reset();
  }
};
int main(int argc, char **argv) {
  QSurfaceFormat format;
  format.setVersion(3, 3);
  format.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(format);
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
  wp::configureNativeRuntime();
  const auto output = QString::fromLocal8Bit(qgetenv("WATCHPAIR_MEDIA_OUTPUT"));
  if (!output.isEmpty())
    QDir().mkpath(output);
  MediaMatrix tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "media_matrix_tests.moc"
