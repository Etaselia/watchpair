#pragma once
#include <QLocalServer>
#include <QLockFile>
#include <QObject>
#include <memory>
namespace wp {
class SingleInstance final : public QObject {
  Q_OBJECT
public:
  SingleInstance(const QString &profile, QObject *parent = nullptr);
  ~SingleInstance() override;
  bool acquireOrForward(const QString &link);
signals:
  void activate(QString link);

private:
  QLocalServer server_;
  std::unique_ptr<QLockFile> lock_;
  QString profile_, name_;
  QByteArray cookie_;
};
namespace desktop {
void registerProtocol();
void installShortcut();
QString executable();
void startAtLogin(bool enabled);
QString desktopEntry(const QString &executable, bool startup = false);
} // namespace desktop
} // namespace wp
