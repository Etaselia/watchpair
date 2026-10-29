#include "native_runtime.h"
#include "window.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFile>
#include <QImage>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QStandardPaths>
#include <QSurfaceFormat>
#include <functional>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/ip_filter.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>

int main(int argc, char **argv) {
  QSurfaceFormat format;
  format.setVersion(3, 3);
  format.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(format);
  QApplication app(argc, argv);
  wp::configureNativeRuntime();
  QCoreApplication::setOrganizationName(QStringLiteral("WatchPairPrototype"));
  QCoreApplication::setApplicationName(QStringLiteral("WatchPairNativePrototype"));
  QCommandLineParser args;
  args.addHelpOption();
  args.addOption(
      {QStringLiteral("profile"), QStringLiteral("Isolated prototype profile"), QStringLiteral("directory")});
  args.addOption({QStringLiteral("torrent"), QStringLiteral("Torrent to open"), QStringLiteral("path")});
  args.addOption({QStringLiteral("download-directory"), QStringLiteral("Prototype download directory"),
                  QStringLiteral("directory")});
  args.addOption({QStringLiteral("test-seed-directory"),
                  QStringLiteral("Local-only smoke-test seed directory"), QStringLiteral("directory")});
  args.addOption({QStringLiteral("test-screenshot"), QStringLiteral("Save smoke-test window screenshot"),
                  QStringLiteral("path")});
  args.addOption(
      {QStringLiteral("test-report"), QStringLiteral("Save smoke-test JSON result"), QStringLiteral("path")});
  args.addOption({QStringLiteral("test-timeout"), QStringLiteral("Smoke-test timeout in milliseconds"),
                  QStringLiteral("milliseconds"), QStringLiteral("120000")});
  args.process(app);
  try {
    const bool smoke = args.isSet(QStringLiteral("test-seed-directory"));
    const auto profile = args.isSet(QStringLiteral("profile"))
                             ? args.value(QStringLiteral("profile"))
                             : QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    wp::Window window(profile, smoke);
    std::unique_ptr<libtorrent::session> seed;
    if (smoke) {
      libtorrent::settings_pack s;
      s.set_str(libtorrent::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
      s.set_bool(libtorrent::settings_pack::enable_dht, false);
      s.set_bool(libtorrent::settings_pack::enable_lsd, false);
      s.set_bool(libtorrent::settings_pack::enable_upnp, false);
      s.set_bool(libtorrent::settings_pack::enable_natpmp, false);
      s.set_bool(libtorrent::settings_pack::close_redundant_connections, false);
      s.set_int(libtorrent::settings_pack::upload_rate_limit, 256 * 1024);
      seed = std::make_unique<libtorrent::session>(s);
      libtorrent::ip_filter limits;
      limits.add_rule(libtorrent::make_address("0.0.0.0"), libtorrent::make_address("255.255.255.255"), 1);
      seed->set_peer_class_filter(limits);
      libtorrent::add_torrent_params p;
      p.ti = std::make_shared<libtorrent::torrent_info>(args.value(QStringLiteral("torrent")).toStdString());
      p.save_path = args.value(QStringLiteral("test-seed-directory")).toStdString();
      p.flags &= ~libtorrent::torrent_flags::auto_managed;
      p.flags &= ~libtorrent::torrent_flags::paused;
      p.flags |= libtorrent::torrent_flags::seed_mode;
      seed->add_torrent(p);
    }
    if (args.isSet(QStringLiteral("torrent"))) {
      auto destination = args.value(QStringLiteral("download-directory"));
      if (destination.isEmpty())
        destination = profile + QStringLiteral("/downloads");
      window.add(args.value(QStringLiteral("torrent")), destination);
    }
    window.show();
    QTimer peer;
    if (smoke) {
      bool started = false, finished = false;
      double nonBlackFraction = 0;
      auto frameColors = [&] {
        const auto frame = window.video().grabFramebuffer();
        QSet<QRgb> colors;
        int bright = 0, samples = 0;
        for (int y = 0; y < frame.height(); y += 16)
          for (int x = 0; x < frame.width(); x += 16) {
            const auto pixel = frame.pixel(x, y);
            colors.insert(pixel);
            ++samples;
            if (qMax(qMax(qRed(pixel), qGreen(pixel)), qBlue(pixel)) > 32)
              ++bright;
          }
        nonBlackFraction = samples ? double(bright) / samples : 0;
        return colors.size();
      };
      std::function<void()> finish = [&] {
        if (finished)
          return;
        finished = true;
        const auto colors = frameColors();
        if (args.isSet(QStringLiteral("test-screenshot"))) {
          window.grab().save(args.value(QStringLiteral("test-screenshot")));
          window.video().grabFramebuffer().save(args.value(QStringLiteral("test-screenshot")) +
                                                QStringLiteral(".frame.png"));
        }
        const bool ok = window.video().rendering() && colors > 8 && nonBlackFraction > 0.4 &&
                        window.player().loaded() && window.player().position() > 0.5 &&
                        window.player().error().isEmpty();
        QJsonObject result{{QStringLiteral("passed"), ok},
                           {QStringLiteral("renderContext"), window.video().rendering()},
                           {QStringLiteral("position"), window.player().position()},
                           {QStringLiteral("torrentProgress"), window.torrent().progress()},
                           {QStringLiteral("error"), window.player().error()},
                           {QStringLiteral("sampledFrameColors"), int(colors)},
                           {QStringLiteral("draws"), window.video().draws()},
                           {QStringLiteral("frames"), window.video().frames()},
                           {QStringLiteral("glError"), window.video().glError()},
                           {QStringLiteral("nonBlackFraction"), nonBlackFraction}};
        if (args.isSet(QStringLiteral("test-report"))) {
          QFile file(args.value(QStringLiteral("test-report")));
          if (file.open(QIODevice::WriteOnly))
            file.write(QJsonDocument(result).toJson());
        }
        app.exit(ok ? 0 : 2);
      };
      QObject::connect(&peer, &QTimer::timeout, &window, [&] {
        if (window.torrent().valid())
          window.torrent().connectPeer(seed->listen_port());
        if (!started && !window.torrent().files().isEmpty()) {
          auto torrents = seed->get_torrents();
          if (!torrents.empty() && torrents[0].status().is_seeding) {
            started = true;
            window.selectVideosAndPlay();
          }
        }
        if (window.video().rendering() && window.player().loaded() && window.player().position() > 1 &&
            frameColors() > 8 && nonBlackFraction > 0.4)
          finish();
      });
      peer.start(1000);
      QTimer::singleShot(args.value(QStringLiteral("test-timeout")).toInt(), &window, finish);
      return app.exec();
    }
    return app.exec();
  } catch (const std::exception &e) {
    fprintf(stderr, "%s\n", e.what());
    return 1;
  }
}
