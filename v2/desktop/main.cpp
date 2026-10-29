#include "lifecycle.h"
#include "main_window.h"
#include "native_runtime.h"
#include "theme.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFileInfo>
#include <QMessageBox>
#include <QProcess>
#include <QStandardPaths>
#include <QSurfaceFormat>
int main(int argc, char **argv) {
  QSurfaceFormat format;
  format.setVersion(3, 3);
  format.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(format);
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
  app.setOrganizationName(QStringLiteral("WatchPair"));
  app.setApplicationName(QStringLiteral("WatchPair"));
  app.setApplicationVersion(QString::fromLatin1(WATCHPAIR_APP_VERSION));
  wp::configureNativeRuntime();
  wp::ui::installTheme();
  QCommandLineParser args;
  args.addHelpOption();
  args.addVersionOption();
  args.addOption(
      {QStringLiteral("non-interactive"), QStringLiteral("Report startup failures without a modal dialog")});
  args.addOption({QStringLiteral("profile"), QStringLiteral("Isolated application profile"),
                  QStringLiteral("directory")});
  args.addOption({QStringLiteral("local-only"),
                  QStringLiteral("Disable external torrent discovery for native integration tests")});
  args.addOption(
      {QStringLiteral("background"), QStringLiteral("Start in the notification area when available")});
  args.addOption({QStringLiteral("screenshot"),
                  QStringLiteral("Save a window screenshot after initialization"), QStringLiteral("path")});
  args.addOption({QStringLiteral("exit-after"),
                  QStringLiteral("Exit after a bounded smoke test in milliseconds"),
                  QStringLiteral("milliseconds")});
  args.addOption({QStringLiteral("page"), QStringLiteral("Initial workspace page for UI validation"),
                  QStringLiteral("page")});
  for (const auto &option : {QStringLiteral("activate-update"), QStringLiteral("recover-update"),
                             QStringLiteral("launch-installed")})
    args.addOption({option, QStringLiteral("Private installer/recovery helper"), QStringLiteral("root")});
  args.addOption({QStringLiteral("wait-pid"), QStringLiteral("Wait for the previous application process"),
                  QStringLiteral("pid")});
  args.addPositionalArgument(QStringLiteral("link"), QStringLiteral("Room invite or recovery link"),
                             QStringLiteral("[link]"));
  args.process(app);
  try {
    for (const auto &action : {QStringLiteral("activate-update"), QStringLiteral("recover-update"),
                               QStringLiteral("launch-installed")}) {
      if (!args.isSet(action))
        continue;
      bool valid = !args.isSet(QStringLiteral("wait-pid"));
      const auto pid = args.value(QStringLiteral("wait-pid")).toLongLong(&valid);
      if (args.isSet(QStringLiteral("wait-pid")) && (!valid || pid <= 0))
        throw wp::AppError(QStringLiteral("INSTALL_HELPER"),
                           QStringLiteral("The previous process id is invalid."));
      wp::delivery::waitForProcess(pid);
      const auto root = args.value(action);
      if (action == QStringLiteral("activate-update"))
        wp::delivery::activate(root);
      if (action == QStringLiteral("recover-update"))
        wp::delivery::rollback(root);
      auto forwarded = args.positionalArguments();
      for (const auto &flag :
           {QStringLiteral("background"), QStringLiteral("local-only"), QStringLiteral("non-interactive")})
        if (args.isSet(flag))
          forwarded << QStringLiteral("--") + flag;
      for (const auto &option :
           {QStringLiteral("exit-after"), QStringLiteral("screenshot"), QStringLiteral("page")})
        if (args.isSet(option))
          forwarded << QStringLiteral("--") + option << args.value(option);
      if (!QProcess::startDetached(wp::delivery::launcher(root), forwarded))
        throw wp::AppError(
            QStringLiteral("INSTALL_HELPER"),
            QStringLiteral("Could not start the installed copy. Open its WatchPair launcher again."));
      return 0;
    }
    const auto profile =
        args.isSet(QStringLiteral("profile"))
            ? QDir(args.value(QStringLiteral("profile"))).absolutePath()
            : QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + QStringLiteral("/v2");
    wp::SingleInstance instance(profile);
    const auto link = args.positionalArguments().value(0);
    if (!instance.acquireOrForward(link))
      return 0;
    wp::AppServices services(profile, nullptr, args.isSet(QStringLiteral("local-only")));
    services.restore();
    if (!wp::delivery::runningRoot().isEmpty() &&
        services.store.setting(QStringLiteral("installationIntegrationPending")).toBool()) {
      services.perform([&] {
        wp::desktop::registerProtocol();
        wp::desktop::installShortcut();
        if (services.store.setting(QStringLiteral("startup")).toBool())
          wp::desktop::startAtLogin(true);
        services.store.setSetting(QStringLiteral("installationIntegrationPending"), false);
      });
    }
    services.player.setAudioDevice(
        services.store.setting(QStringLiteral("audioDevice"), QStringLiteral("auto")).toString());
    services.player.setSubtitleScale(services.store.setting(QStringLiteral("subtitleScale"), 1).toDouble());
    wp::ui::MainWindow window(services);
    QObject::connect(
        &services.releases, &wp::ReleaseManager::restartRequested, &window,
        [&](const QString &root, const QString &action) {
          services.perform([&] {
            const auto option = action == QStringLiteral("activate")   ? QStringLiteral("--activate-update")
                                : action == QStringLiteral("rollback") ? QStringLiteral("--recover-update")
                                                                       : QStringLiteral("--launch-installed");
            auto exe = QCoreApplication::applicationFilePath();
#ifndef Q_OS_WIN
            const auto appRun = wp::delivery::bundleRoot() + QStringLiteral("/AppRun");
            if (QFileInfo::exists(appRun))
              exe = appRun;
#endif
            if (!QProcess::startDetached(exe, {option, root, QStringLiteral("--wait-pid"),
                                               QString::number(QCoreApplication::applicationPid())}))
              throw wp::AppError(
                  QStringLiteral("INSTALL_HELPER"),
                  QStringLiteral("Could not prepare the installer. This session is still open."));
            app.quit();
          });
        });
    if (!args.isSet(QStringLiteral("background")) || !QSystemTrayIcon::isSystemTrayAvailable())
      window.show();
    QObject::connect(&instance, &wp::SingleInstance::activate, &window, [&](const QString &link) {
      window.restoreWindow();
      if (!link.isEmpty())
        window.openLink(link);
    });
    QObject::connect(&app, &QApplication::aboutToQuit, &window, [&] {
      window.prepareToQuit();
      services.shutdown();
    });
    QTimer::singleShot(2000, &window, [&] { services.perform([] { wp::delivery::markHealthy(); }); });
    if (!args.positionalArguments().isEmpty())
      QTimer::singleShot(0, &window, [&] { window.openLink(args.positionalArguments().first()); });
    if (args.value(QStringLiteral("page")) == QStringLiteral("transfers"))
      window.showTransfers();
    if (args.isSet(QStringLiteral("screenshot")))
      QTimer::singleShot(2500, &window,
                         [&] { window.grab().save(args.value(QStringLiteral("screenshot"))); });
    if (args.isSet(QStringLiteral("exit-after")))
      QTimer::singleShot(std::clamp(args.value(QStringLiteral("exit-after")).toInt(), 3000, 600000), &window,
                         &QApplication::quit);
    return app.exec();
  } catch (const std::exception &e) {
    if (args.isSet(QStringLiteral("non-interactive")))
      qCritical("WatchPair startup failed: %s", e.what());
    else
      QMessageBox::critical(nullptr, QStringLiteral("WatchPair could not start"),
                            QString::fromUtf8(e.what()));
    return 1;
  }
}
