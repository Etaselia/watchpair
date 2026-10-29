#include "library_service.h"
#include "transfer_engine.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QPointer>
#include <QUuid>
#include <QtConcurrent>
#include <algorithm>

namespace wp {
namespace {
QJsonObject hashFile(const QString &path, const std::shared_ptr<std::atomic_bool> &stop) {
  QFileInfo before(path);
  if (!before.isFile() || before.isSymLink())
    throw std::runtime_error("The source is missing or is a symbolic link.");
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly))
    throw std::runtime_error("Cannot read the local media file.");
  QCryptographicHash hash(QCryptographicHash::Sha256);
  while (!file.atEnd()) {
    if (stop->load())
      return {};
    const auto chunk = file.read(1024 * 1024);
    if (chunk.isEmpty() && file.error() != QFile::NoError)
      throw std::runtime_error("Reading the local media failed.");
    hash.addData(chunk);
  }
  QFileInfo after(path);
  if (before.size() != after.size() || before.lastModified() != after.lastModified() || !after.isFile() ||
      after.isSymLink())
    throw std::runtime_error(
        "The file changed while it was being identified. Try again after its download or copy completes.");
  const auto canonical = after.canonicalFilePath();
  return {
      {QStringLiteral("id"),
       QString::fromLatin1(QCryptographicHash::hash(canonical.toUtf8(), QCryptographicHash::Sha256).toHex())},
      {QStringLiteral("path"), canonical},
      {QStringLiteral("label"), after.fileName()},
      {QStringLiteral("size"), after.size()},
      {QStringLiteral("mtime"), after.lastModified().toMSecsSinceEpoch()},
      {QStringLiteral("sha256"), QString::fromLatin1(hash.result().toHex())},
      {QStringLiteral("missing"), false}};
}
} // namespace
LibraryService::LibraryService(LocalStore &store, QObject *parent)
    : QObject(parent), store_(store), cancel_(std::make_shared<std::atomic_bool>(false)) {
  pool_.setMaxThreadCount(2);
}
LibraryService::~LibraryService() {
  cancel();
  pool_.waitForDone();
}
QString LibraryService::addRoot(const QString &path) {
  QFileInfo info(path);
  if (!info.isDir() || info.isSymLink() || !info.isReadable())
    throw AppError(QStringLiteral("LIBRARY_ROOT"),
                   QStringLiteral("Choose an accessible local folder, using its actual path."));
  const auto canonical = info.canonicalFilePath();
  for (auto value : roots())
    if (value.toObject().value(QStringLiteral("path")).toString() == canonical)
      return value.toObject().value(QStringLiteral("id")).toString();
  const auto id = QUuid::createUuid().toString(QUuid::WithoutBraces);
  store_.put(QStringLiteral("library-root"), id,
             {{QStringLiteral("id"), id},
              {QStringLiteral("path"), canonical},
              {QStringLiteral("label"), info.fileName()}});
  emit changed();
  return id;
}
void LibraryService::removeRoot(const QString &id) {
  if (scanning_)
    throw AppError(QStringLiteral("LIBRARY_BUSY"),
                   QStringLiteral("Cancel the current scan before removing a library folder."));
  store_.transaction([&] {
    for (const auto value : store_.find(QStringLiteral("library-file"), QStringLiteral("root"), id))
      store_.remove(QStringLiteral("library-file"), value.toObject().value(QStringLiteral("id")).toString());
    store_.remove(QStringLiteral("library-root"), id);
  });
  emit changed();
}
bool LibraryService::unchanged(const QJsonObject &row) {
  const QFileInfo f(row.value(QStringLiteral("path")).toString());
  return !row.isEmpty() && f.isFile() && !f.isSymLink() &&
         f.size() == row.value(QStringLiteral("size")).toInteger(-1) &&
         f.lastModified().toMSecsSinceEpoch() == row.value(QStringLiteral("mtime")).toInteger(-1) &&
         !row.value(QStringLiteral("sha256")).toString().isEmpty();
}
void LibraryService::scan(const QString &rootId) {
  if (scanning_)
    throw AppError(QStringLiteral("LIBRARY_BUSY"), QStringLiteral("A library scan is already running."));
  const auto root = store_.get(QStringLiteral("library-root"), rootId);
  if (root.isEmpty())
    throw AppError(QStringLiteral("LIBRARY_ROOT"), QStringLiteral("This library folder no longer exists."));
  const auto path = root.value(QStringLiteral("path")).toString();
  const auto cached = store_.find(QStringLiteral("library-file"), QStringLiteral("root"), rootId);
  cancel_->store(false);
  scanning_ = true;
  emit progress(QStringLiteral("Scanning %1…").arg(root.value(QStringLiteral("label")).toString()));
  auto *watcher = new QFutureWatcher<ScanResult>(this);
  connect(watcher, &QFutureWatcher<ScanResult>::finished, this, [this, watcher, rootId] {
    const auto result = watcher->result();
    watcher->deleteLater();
    scanning_ = false;
    if (!result.cancelled && result.error.isEmpty()) {
      try {
        QSet<QString> found;
        store_.transaction([&] {
          for (const auto item : result.files) {
            auto row = item.toObject();
            const auto id = row.value(QStringLiteral("id")).toString();
            found.insert(id);
            row.insert(QStringLiteral("root"), rootId);
            store_.put(QStringLiteral("library-file"), id, row);
          }
          for (const auto item :
               store_.find(QStringLiteral("library-file"), QStringLiteral("root"), rootId)) {
            auto row = item.toObject();
            const auto id = row.value(QStringLiteral("id")).toString();
            if (!found.contains(id)) {
              row.insert(QStringLiteral("missing"), true);
              store_.put(QStringLiteral("library-file"), id, row);
            }
          }
        });
        emit progress(
            QStringLiteral(
                "Library scan complete: %1 identified files, %2 unreadable or changed files skipped.")
                .arg(result.files.size())
                .arg(result.skipped));
      } catch (const AppError &e) {
        emit failed(rootId, e.message());
      }
    } else if (!result.error.isEmpty())
      emit failed(rootId, result.error);
    else
      emit progress(QStringLiteral("Library scan cancelled."));
    emit changed();
  });
  const auto stop = cancel_;
  watcher->setFuture(QtConcurrent::run(&pool_, [path, cached, stop] {
    ScanResult result;
    QHash<QString, QJsonObject> known;
    for (const auto item : cached) {
      auto row = item.toObject();
      known.insert(row.value(QStringLiteral("path")).toString(), row);
    }
    if (!QFileInfo(path).isDir()) {
      result.error = QStringLiteral("Library folder is unavailable. Reconnect its drive and scan again.");
      return result;
    }
    QDirIterator files(path, QDir::Files | QDir::NoSymLinks | QDir::Readable, QDirIterator::Subdirectories);
    while (files.hasNext()) {
      if (stop->load()) {
        result.cancelled = true;
        return result;
      }
      const auto name = files.next();
      if (!TransferEngine::video(name) &&
          !QStringList{QStringLiteral("srt"), QStringLiteral("ass"), QStringLiteral("ssa"),
                       QStringLiteral("vtt"), QStringLiteral("sub"), QStringLiteral("idx")}
               .contains(QFileInfo(name).suffix().toLower()))
        continue;
      const auto canonical = QFileInfo(name).canonicalFilePath();
      if (!canonical.startsWith(QDir(path).canonicalPath() + QLatin1Char('/')))
        continue;
      try {
        auto row = known.value(canonical);
        if (!LibraryService::unchanged(row))
          row = hashFile(canonical, stop);
        if (!row.isEmpty()) {
          row.insert(QStringLiteral("missing"), false);
          result.files.append(row);
        }
      } catch (const std::exception &) {
        ++result.skipped;
      }
      if (result.files.size() >= 50000) {
        result.error =
            QStringLiteral("This folder exceeds the 50,000-file scan limit. Add smaller library roots.");
        return result;
      }
    }
    result.cancelled = stop->load();
    return result;
  }));
}
void LibraryService::cancel() {
  cancelScan();
  for (const auto &job : jobs_)
    job->store(true);
}
void LibraryService::cancelScan() {
  cancel_->store(true);
}
void LibraryService::cancel(const QString &operation) {
  if (jobs_.contains(operation))
    jobs_.value(operation)->store(true);
}
QJsonArray LibraryService::roots() const {
  return store_.all(QStringLiteral("library-root"));
}
QJsonArray LibraryService::files(const QString &search) const {
  QJsonArray result;
  for (const auto value : store_.all(QStringLiteral("library-file"))) {
    const auto row = value.toObject();
    if (search.isEmpty() ||
        row.value(QStringLiteral("path")).toString().contains(search, Qt::CaseInsensitive))
      result.append(row);
  }
  return result;
}
QJsonObject LibraryService::match(const QString &sha) const {
  if (sha.size() != 64)
    return {};
  for (const auto value : store_.find(QStringLiteral("library-file"), QStringLiteral("sha256"), sha)) {
    const auto row = value.toObject();
    if (unchanged(row))
      return row;
  }
  return {};
}
QJsonObject LibraryService::file(const QString &id) const {
  return store_.get(QStringLiteral("library-file"), id);
}
void LibraryService::tag(const QString &id, const QJsonObject &fields) {
  auto row = file(id);
  if (row.isEmpty())
    return;
  for (auto it = fields.begin(); it != fields.end(); ++it)
    if (it.key() == QStringLiteral("managedTransfer") || it.key() == QStringLiteral("managedIndex"))
      row.insert(it.key(), it.value());
  store_.put(QStringLiteral("library-file"), id, row);
  emit changed();
}
void LibraryService::refreshAvailability(const QString &root) {
  bool changedFiles = false;
  store_.transaction([&] {
    for (auto value : store_.all(QStringLiteral("library-file"))) {
      auto row = value.toObject();
      const auto path = row.value(QStringLiteral("path")).toString();
      if (!root.isEmpty() && path != root && !path.startsWith(root + QLatin1Char('/')))
        continue;
      const bool missing = !unchanged(row);
      if (row.value(QStringLiteral("missing")).toBool() != missing) {
        row.insert(QStringLiteral("missing"), missing);
        store_.put(QStringLiteral("library-file"), row.value(QStringLiteral("id")).toString(), row);
        changedFiles = true;
      }
    }
  });
  if (changedFiles)
    emit changed();
}
QString LibraryService::identify(const QString &path) {
  const auto op = QUuid::createUuid().toString(QUuid::WithoutBraces);
  auto *watcher = new QFutureWatcher<QJsonObject>(this);
  const auto stop = std::make_shared<std::atomic_bool>(false);
  jobs_.insert(op, stop);
  connect(watcher, &QFutureWatcher<QJsonObject>::finished, this, [this, watcher, op, stop] {
    jobs_.remove(op);
    if (stop->load()) {
      emit cancelled(op);
      watcher->deleteLater();
      return;
    }
    try {
      const auto row = watcher->result();
      if (!row.isEmpty()) {
        store_.put(QStringLiteral("library-file"), row.value(QStringLiteral("id")).toString(), row);
        emit identified(op, row);
        emit changed();
      }
    } catch (const std::exception &) {
      emit failed(op, QStringLiteral("Could not identify this file. Check read access and wait for any write "
                                     "or download to complete."));
    }
    watcher->deleteLater();
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [path, stop] { return hashFile(path, stop); }));
  return op;
}
void LibraryService::registerIdentified(QJsonObject file) {
  registerIdentified(QJsonArray{file});
}
void LibraryService::registerIdentified(const QJsonArray &files) {
  store_.transaction([&] {
    for (auto value : files) {
      auto file = value.toObject();
      if (!unchanged(file) || file.value(QStringLiteral("id")).toString().isEmpty())
        throw AppError(QStringLiteral("LIBRARY_FILE"),
                       QStringLiteral("A prepared file changed before it could be registered."));
      file.insert(QStringLiteral("missing"), false);
      store_.put(QStringLiteral("library-file"), file.value(QStringLiteral("id")).toString(), file);
    }
  });
  emit changed();
}
LocalFileSource::LocalFileSource(QJsonObject file, QObject *parent)
    : MediaSource(parent), file_(std::move(file)) {
}
QList<TorrentFile> LocalFileSource::files() const {
  return {{0, file_.value(QStringLiteral("label")).toString(), totalSize(), 0}};
}
qint64 LocalFileSource::totalSize() const {
  return file_.value(QStringLiteral("size")).toInteger();
}
int LocalFileSource::pieceSize(int p) const {
  return p >= 0 && qint64(p) * pieceLength() < totalSize()
             ? int(std::min<qint64>(pieceLength(), totalSize() - qint64(p) * pieceLength()))
             : 0;
}
bool LocalFileSource::hasPiece(int p) const {
  return pieceSize(p) > 0 && LibraryService::unchanged(file_);
}
void LocalFileSource::readPiece(int p) {
  if (!hasPiece(p)) {
    emit pieceRead(
        p, {},
        QStringLiteral("The local file changed or became unavailable. Rescan or locate the matching copy."));
    return;
  }
  auto *watcher = new QFutureWatcher<QByteArray>(this);
  const auto file = file_;
  const auto offset = qint64(p) * pieceLength();
  const auto length = pieceSize(p);
  connect(watcher, &QFutureWatcher<QByteArray>::finished, this, [this, watcher, p, length] {
    const auto bytes = watcher->result();
    watcher->deleteLater();
    emit pieceRead(p, bytes,
                   bytes.size() == length && LibraryService::unchanged(file_)
                       ? QString()
                       : QStringLiteral("The verified local copy is unavailable or changed."));
  });
  watcher->setFuture(QtConcurrent::run([file, offset, length] {
    QFile input(file.value(QStringLiteral("path")).toString());
    if (!input.open(QIODevice::ReadOnly) || !input.seek(offset))
      return QByteArray();
    return input.read(length);
  }));
}
} // namespace wp
