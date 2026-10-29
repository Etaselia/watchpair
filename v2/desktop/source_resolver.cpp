#include "source_resolver.h"
#include "transfer_engine.h"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFutureWatcher>
#include <QRegularExpression>
#include <QSaveFile>
#include <QTimer>
#include <QUuid>
#include <QtConcurrent>
#include <libtorrent/torrent_info.hpp>
namespace wp {
SourceResolver::SourceResolver(LocalStore &store, QObject *parent) : QObject(parent), store_(store) {
  pool_.setMaxThreadCount(2);
  route_ = store_.setting(QStringLiteral("transfer")).toObject();
}
SourceResolver::~SourceResolver() {
  for (const auto &control : pending_)
    control->cancelled.store(true);
  pool_.waitForDone();
}
QString SourceResolver::cacheTorrent(const QByteArray &data) {
  if (data.isEmpty() || data.size() > 16 * 1024 * 1024)
    throw AppError(QStringLiteral("TORRENT_SIZE"),
                   QStringLiteral("Torrent metadata is empty or exceeds 16 MiB."));
  try {
    libtorrent::torrent_info check(libtorrent::span<const char>(data.constData(), data.size()),
                                   libtorrent::from_span);
  } catch (...) {
    throw AppError(QStringLiteral("TORRENT_INVALID"),
                   QStringLiteral("The link did not return a valid torrent. Download its .torrent file and "
                                  "add that file instead."));
  }
  const auto root = store_.profile() + QStringLiteral("/metadata");
  if (!QDir().mkpath(root))
    throw AppError(QStringLiteral("STORAGE_ACCESS"), QStringLiteral("Cannot create the metadata cache."));
  const auto path = root + QLatin1Char('/') +
                    QString::fromLatin1(QCryptographicHash::hash(data, QCryptographicHash::Sha256).toHex()) +
                    QStringLiteral(".torrent");
  QSaveFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(data) != data.size() || !file.commit())
    throw AppError(QStringLiteral("STORAGE_ACCESS"), QStringLiteral("Cannot save torrent metadata."));
  return path;
}
QString SourceResolver::resolve(const QString &input, bool automatic) {
  const auto op = QUuid::createUuid().toString(QUuid::WithoutBraces), text = input.trimmed();
  // Defer local completions as well so callers can register the operation ID
  // before any result arrives.
  QTimer::singleShot(0, this, [this, op, text, automatic] {
    if (cancelled_.remove(op))
      return;
    try {
      if (text.startsWith(QStringLiteral("magnet:"))) {
        emit resolved({op, QStringLiteral("torrent"), text, {}, QStringLiteral("Magnet link")});
        return;
      }
      QUrl url(text);
      if (automatic && url.scheme() != QStringLiteral("http") && url.scheme() != QStringLiteral("https"))
        throw AppError(
            QStringLiteral("SOURCE_LOCAL_APPROVAL"),
            QStringLiteral(
                "A room cannot open a local path on this device. Add or locate the file explicitly."));
      QString local = url.isLocalFile() ? url.toLocalFile() : text;
      const QFileInfo info(local);
      if (info.exists()) {
        if (info.isSymLink())
          throw AppError(QStringLiteral("SOURCE_SYMLINK"),
                         QStringLiteral("Add the actual file or folder instead of a symbolic link."));
        if (info.isDir()) {
          emit resolved({op, QStringLiteral("folder"), {}, info.canonicalFilePath(), info.fileName()});
          return;
        }
        if (info.suffix().compare(QStringLiteral("torrent"), Qt::CaseInsensitive) == 0) {
          QFile file(info.absoluteFilePath());
          if (!file.open(QIODevice::ReadOnly))
            throw AppError(QStringLiteral("SOURCE_ACCESS"), QStringLiteral("Cannot read this torrent file."));
          const auto path = cacheTorrent(file.read(16 * 1024 * 1024 + 1));
          emit resolved({op, QStringLiteral("torrent"), QUrl::fromLocalFile(path).toString(), path,
                         info.completeBaseName()});
          return;
        }
        emit resolved({op, QStringLiteral("local"), {}, info.canonicalFilePath(), info.fileName()});
        return;
      }
      if (!url.isValid() ||
          (url.scheme() != QStringLiteral("https") && url.scheme() != QStringLiteral("http")) ||
          url.host().isEmpty() || !url.userInfo().isEmpty())
        throw AppError(
            QStringLiteral("SOURCE_UNSUPPORTED"),
            QStringLiteral(
                "Add a magnet, .torrent file, Nyaa page, direct media URL, or local file/folder."));
      if ((url.host().compare(QStringLiteral("nyaa.si"), Qt::CaseInsensitive) == 0 ||
           url.host().compare(QStringLiteral("www.nyaa.si"), Qt::CaseInsensitive) == 0) &&
          QRegularExpression(QStringLiteral("^/view/[0-9]+/?$")).match(url.path()).hasMatch()) {
        const auto number = url.path().split(QLatin1Char('/'), Qt::SkipEmptyParts).value(1);
        fetchTorrent(op, QUrl(QStringLiteral("https://nyaa.si/download/%1.torrent").arg(number)), automatic);
        return;
      }
      if (url.path().endsWith(QStringLiteral(".torrent"), Qt::CaseInsensitive)) {
        fetchTorrent(op, url, automatic);
        return;
      }
      if (TransferEngine::video(url.path())) {
        probeMedia(op, url, automatic);
        return;
      }
      throw AppError(QStringLiteral("SOURCE_PAGE"),
                     QStringLiteral("This page is not a supported source. Copy its magnet link, .torrent "
                                    "download link, or direct video URL."));
    } catch (const AppError &e) {
      emit failed(op, e.code(), e.message());
    } catch (...) {
      emit failed(
          op, QStringLiteral("SOURCE_FAILED"),
          QStringLiteral("The source could not be opened. Check the link or choose a local torrent file."));
    }
  });
  return op;
}
void SourceResolver::fetchTorrent(const QString &op, const QUrl &url, bool automatic) {
  emit progress(op, QStringLiteral("Retrieving torrent metadata…"));
  fetch(op, url, false, automatic);
}
void SourceResolver::probeMedia(const QString &op, const QUrl &url, bool automatic) {
  emit progress(op, QStringLiteral("Checking media URL…"));
  fetch(op, url, true, automatic);
}
void SourceResolver::fetch(const QString &op, const QUrl &url, bool head, bool automatic) {
  const auto config = store_.setting(QStringLiteral("transfer")).toObject();
  if (config.value(QStringLiteral("offline")).toBool()) {
    emit failed(op, QStringLiteral("OFFLINE"),
                QStringLiteral("Turn off offline mode to resolve network sources."));
    return;
  }
  HttpOptions options;
  options.url = url;
  options.head = head;
  options.allowPrivate = !automatic;
  options.control = std::make_shared<HttpControl>();
  options.control->budget = budget_;
  options.bindAddress = config.value(QStringLiteral("bind")).toString();
  options.proxyHost = config.value(QStringLiteral("proxyHost")).toString();
  options.proxyPort = config.value(QStringLiteral("proxyPort")).toInt(1080);
  pending_.insert(op, options.control);
  emit networkActivity(pending_.size());
  auto *watcher = new QFutureWatcher<HttpResult>(this);
  connect(watcher, &QFutureWatcher<HttpResult>::finished, this, [this, watcher, op, url, head] {
    pending_.remove(op);
    emit networkActivity(pending_.size());
    cancelled_.remove(op);
    watcher->deleteLater();
    try {
      const auto result = watcher->result();
      if (result.cancelled) {
        emit failed(op, QStringLiteral("CANCELLED"), QStringLiteral("Source resolution cancelled."));
        return;
      }
      if (!result.error.isEmpty() && !(head && (result.status == 405 || result.status == 501))) {
        emit failed(op, QStringLiteral("SOURCE_NETWORK"), result.error);
        return;
      }
      if (head)
        emit resolved({op, QStringLiteral("direct"), url.toString(), {}, QFileInfo(url.path()).fileName()});
      else {
        const auto path = cacheTorrent(result.body);
        emit resolved(
            {op, QStringLiteral("torrent"), url.toString(), path, QFileInfo(url.path()).completeBaseName()});
      }
    } catch (const AppError &e) {
      emit failed(op, e.code(), e.message());
    } catch (...) {
      emit failed(op, QStringLiteral("SOURCE_FAILED"), QStringLiteral("The source could not be resolved."));
    }
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [options] { return fetchHttp(options); }));
}
void SourceResolver::networkChanged() {
  const auto config = store_.setting(QStringLiteral("transfer")).toObject();
  bool changed = false;
  for (const auto &key : {QStringLiteral("bind"), QStringLiteral("proxyHost"), QStringLiteral("proxyPort"),
                          QStringLiteral("offline")})
    changed |= route_.value(key) != config.value(key);
  route_ = config;
  if (changed)
    for (const auto &control : pending_)
      control->cancelled.store(true);
}
void SourceResolver::cancel(const QString &op) {
  if (auto control = pending_.value(op))
    control->cancelled.store(true);
  else {
    cancelled_.insert(op);
    if (cancelled_.size() > 1000)
      cancelled_.clear();
  }
}
} // namespace wp
