#include "storage_manager.h"
#include "app_services.h"
#include "owned_storage.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QFutureWatcher>
#include <QSaveFile>
#include <QStorageInfo>
#include <QtConcurrent>
namespace wp {
namespace {
struct MoveResult {
  QString error;
  QJsonObject hashes;
  MoveResult(QString value = {}) : error(std::move(value)) {}
};
QString field(const QString &kind) {
  return kind == QStringLiteral("share")     ? QStringLiteral("share-download")
         : kind == QStringLiteral("torrent") ? QStringLiteral("transfer")
                                             : QStringLiteral("direct");
}
QStringList files(const QJsonObject &row) {
  QStringList paths;
  const auto root = row.value(QStringLiteral("root")).toString();
  if (row.value(QStringLiteral("kind")).toString() == QStringLiteral("torrent")) {
    for (auto v : row.value(QStringLiteral("diskPaths")).toObject())
      paths.append(QDir(root).absoluteFilePath(v.toString()));
  } else {
    const auto path = row.value(QStringLiteral("path")).toString();
    if (!path.isEmpty()) {
      paths.append(path);
      paths.append(path + QStringLiteral(".part"));
    }
  }
  return paths;
}
bool contained(const QJsonObject &row, const QString &path) {
  const auto root = row.value(QStringLiteral("root")).toString();
  const auto parent = QFileInfo(path).dir().canonicalPath();
  return owned::directory(row) && !QFileInfo(path).isSymLink() &&
         (parent == root || parent.startsWith(root + QLatin1Char('/')));
}
QByteArray digest(const QString &path, const std::shared_ptr<std::atomic_bool> &stop) {
  QFile file(path);
  if (QFileInfo(path).isSymLink() || !file.open(QIODevice::ReadOnly))
    return {};
  QCryptographicHash sha(QCryptographicHash::Sha256);
  while (!file.atEnd()) {
    if (stop->load())
      return {};
    const auto bytes = file.read(1024 * 1024);
    if (bytes.isEmpty() && file.error() != QFile::NoError)
      return {};
    sha.addData(bytes);
  }
  return sha.result();
}
void pruneMarker(const QJsonObject &row) {
  const auto root = row.value(QStringLiteral("root")).toString();
  if (owned::directory(row) && QDir(root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot) ==
                                   QStringList{QStringLiteral(".watchpair-owner")}) {
    QFile::remove(root + QStringLiteral("/.watchpair-owner"));
    QDir().rmdir(root);
  }
}
} // namespace
StorageManager::StorageManager(AppServices &app) : app_(app) {
  pool_.setMaxThreadCount(1);
  connect(&timer_, &QTimer::timeout, this, &StorageManager::automatic);
  timer_.start(60000);
}
StorageManager::~StorageManager() {
  stop_->store(true);
  pool_.waitForDone();
}
void StorageManager::restore() {
  for (auto v : app_.store.all(QStringLiteral("file-move"))) {
    const auto row = v.toObject();
    if (row.value(QStringLiteral("committed")).toBool())
      finishMove(row);
    else
      runMove(row);
  }
}
QJsonArray StorageManager::inventory() const {
  QJsonArray rows;
  QStringList offeredPaths;
  for (auto v : app_.store.all(QStringLiteral("share-offer"))) {
    const auto offer = v.toObject();
    const auto room = offer.value(QStringLiteral("room")).toString(),
               source = offer.value(QStringLiteral("source")).toString();
    if (offer.value(QStringLiteral("disabled")).toBool())
      continue;
    bool present = false;
    for (auto s : app_.rooms.room(room).value(QStringLiteral("sources")).toArray())
      if (s.toObject().value(QStringLiteral("id")).toString() == source)
        present = true;
    if (!present)
      continue;
    for (auto f : app_.sharing.bundle(offer.value(QStringLiteral("bundle")).toString())
                      .value(QStringLiteral("files"))
                      .toArray())
      offeredPaths.append(f.toObject().value(QStringLiteral("path")).toString());
  }
  for (const auto &kind : {QStringLiteral("torrent"), QStringLiteral("direct"), QStringLiteral("share"),
                           QStringLiteral("retained")})
    for (auto value : app_.store.all(kind == QStringLiteral("retained") ? QStringLiteral("retained-media")
                                                                        : field(kind))) {
      auto row = value.toObject();
      const auto id = row.value(QStringLiteral("id")).toString();
      if (kind != QStringLiteral("retained"))
        row.insert(QStringLiteral("kind"), kind);
      row.insert(QStringLiteral("key"), kind + QLatin1Char(':') + id);
      row.insert(QStringLiteral("retained"), kind == QStringLiteral("retained"));
      if (row.value(QStringLiteral("kind")).toString() == QStringLiteral("torrent"))
        row.insert(QStringLiteral("root"), row.value(QStringLiteral("path")));
      const auto root = row.value(QStringLiteral("root")).toString();
      bool used = app_.playback.usesPath(root);
      if (!root.isEmpty())
        for (const auto &path : offeredPaths)
          if (path == root || path.startsWith(root + QLatin1Char('/')))
            used = true;
      if (kind == QStringLiteral("torrent"))
        used = used || app_.transfers.view(id).inUse || app_.transfers.view(id).moving;
      if (kind == QStringLiteral("direct")) {
        used = used || app_.direct.busy(id);
      }
      if (kind == QStringLiteral("share"))
        used = used || app_.sharing.busy(id);
      used = used || moving_.contains(kind + QLatin1Char(':') + id);
      row.insert(QStringLiteral("inUse"), used);
      row.insert(QStringLiteral("owned"),
                 !row.value(QStringLiteral("external")).toBool() && owned::directory(row));
      bool referenced = false, allWatched = true, uncertain = false;
      qint64 latest = row.value(QStringLiteral("createdAt")).toInteger();
      for (auto v : app_.rooms.rooms()) {
        const auto room = v.toObject().value(QStringLiteral("key")).toString();
        const auto snapshot = app_.rooms.room(room);
        QSet<QString> sources;
        for (auto mapping : app_.store.find(QStringLiteral("room-source"), QStringLiteral("room"), room)) {
          const auto local = mapping.toObject();
          if (local.value(QStringLiteral("transfer")).toString() == id ||
              local.value(QStringLiteral("download")).toString() == id)
            sources.insert(local.value(QStringLiteral("source")).toString());
        }
        for (auto entry : snapshot.value(QStringLiteral("entries")).toArray()) {
          const auto e = entry.toObject();
          const bool matches = sources.contains(e.value(QStringLiteral("sourceId")).toString()) ||
                               (!row.value(QStringLiteral("sha256")).toString().isEmpty() &&
                                e.value(QStringLiteral("sha256")) == row.value(QStringLiteral("sha256")));
          if (!matches || !e.value(QStringLiteral("enabled")).toBool())
            continue;
          referenced = true;
          uncertain = uncertain || !app_.rooms.connected(room);
          allWatched = allWatched && !e.value(QStringLiteral("watchedAt")).isNull() &&
                       e.contains(QStringLiteral("watchedAt"));
          latest = std::max(latest, e.value(QStringLiteral("watchedAt")).toInteger());
        }
      }
      const bool removed =
          kind == QStringLiteral("retained") || row.value(QStringLiteral("removed")).toBool();
      row.insert(QStringLiteral("eligible"), removed || (referenced && allWatched && !uncertain));
      row.insert(QStringLiteral("lastUsed"), latest);
      QString reason =
          !row.value(QStringLiteral("owned")).toBool()
              ? QStringLiteral("External or unavailable folder · kept")
          : row.value(QStringLiteral("pinned")).toBool() ? QStringLiteral("Pinned · kept")
          : used                                         ? QStringLiteral("In use · kept")
          : row.value(QStringLiteral("moving")).toBool() ? QStringLiteral("Storage move pending · kept")
          : removed                                      ? QStringLiteral("Removed transfer · eligible")
          : uncertain                                    ? QStringLiteral("Room state unavailable · kept")
          : referenced && allWatched ? QStringLiteral("Watched in every referencing room · eligible")
                                     : QStringLiteral("Unwatched or unreferenced · kept");
      row.insert(QStringLiteral("reason"), reason);
      rows.append(row);
    }
  return rows;
}
void StorageManager::refresh() {
  if (scanning_)
    return;
  scanning_ = true;
  const auto rows = inventory();
  const auto stop = stop_;
  auto *watcher = new QFutureWatcher<QJsonArray>(this);
  connect(watcher, &QFutureWatcher<QJsonArray>::finished, this, [this, watcher] {
    scanning_ = false;
    const auto rows = watcher->result();
    watcher->deleteLater();
    emit previewReady(rows);
    if (automatic_) {
      automatic_ = false;
      for (auto v : candidates(rows)) {
        try {
          remove(v.toObject().value(QStringLiteral("key")).toString(), true, true);
        } catch (const AppError &e) {
          emit problem(e.code(), e.message());
        }
      }
    }
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [rows, stop] {
    QJsonArray result;
    for (auto value : rows) {
      if (stop->load())
        break;
      auto row = value.toObject();
      qint64 bytes = 0, modified = 0;
      for (const auto &path : files(row))
        if (contained(row, path)) {
          const QFileInfo info(path);
          if (!info.isFile())
            continue;
          bytes += info.size();
          modified = std::max(modified, info.lastModified().toMSecsSinceEpoch());
        }
      row.insert(QStringLiteral("bytes"), bytes);
      row.insert(QStringLiteral("lastUsed"),
                 std::max(modified, row.value(QStringLiteral("lastUsed")).toInteger()));
      result.append(row);
    }
    return result;
  }));
}
void StorageManager::setPinned(const QString &key, bool pinned) {
  for (auto v : inventory()) {
    const auto row = v.toObject();
    if (row.value(QStringLiteral("key")).toString() != key)
      continue;
    const auto kind = row.value(QStringLiteral("kind")).toString(),
               id = row.value(QStringLiteral("id")).toString();
    if (row.value(QStringLiteral("retained")).toBool()) {
      auto next = app_.store.get(QStringLiteral("retained-media"), id);
      next.insert(QStringLiteral("pinned"), pinned);
      app_.store.put(QStringLiteral("retained-media"), id, next);
    } else if (kind == QStringLiteral("torrent"))
      app_.transfers.setPinned(id, pinned);
    else if (kind == QStringLiteral("share"))
      app_.sharing.pin(id, pinned);
    else
      app_.direct.setPinned(id, pinned);
    emit changed();
    return;
  }
}
void StorageManager::eraseRetained(const QJsonObject &row) {
  if (!owned::directory(row))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("Restore the owned folder before deleting its files."));
  for (const auto &path : files(row)) {
    if (!QFileInfo::exists(path))
      continue;
    if (!contained(row, path) || !QFile::remove(path))
      throw AppError(
          QStringLiteral("STORAGE_DELETE"),
          QStringLiteral("Some managed files could not be deleted. Close other programs and retry cleanup."));
    QDir directory = QFileInfo(path).dir();
    while (directory.absolutePath() != row.value(QStringLiteral("root")).toString() &&
           directory.entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot).isEmpty()) {
      const auto name = directory.dirName();
      directory.cdUp();
      if (!directory.rmdir(name))
        break;
    }
  }
  pruneMarker(row);
  app_.store.remove(QStringLiteral("retained-media"), row.value(QStringLiteral("id")).toString());
}
void StorageManager::remove(const QString &key, bool erase, bool onlyEligible) {
  QJsonObject row;
  for (auto v : inventory())
    if (v.toObject().value(QStringLiteral("key")).toString() == key) {
      row = v.toObject();
      break;
    }
  if (row.isEmpty())
    return;
  if (onlyEligible && !row.value(QStringLiteral("eligible")).toBool())
    return;
  if (erase && !row.value(QStringLiteral("owned")).toBool())
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("Only verified WatchPair-owned copies can be deleted."));
  if (row.value(QStringLiteral("inUse")).toBool() || row.value(QStringLiteral("pinned")).toBool() ||
      row.value(QStringLiteral("moving")).toBool())
    throw AppError(
        QStringLiteral("STORAGE_BUSY"),
        QStringLiteral("Stop playback, finish the storage move and unpin this copy before removing it."));
  const auto kind = row.value(QStringLiteral("kind")).toString(),
             id = row.value(QStringLiteral("id")).toString();
  if (row.value(QStringLiteral("retained")).toBool()) {
    if (erase)
      eraseRetained(row);
  } else if (kind == QStringLiteral("torrent"))
    app_.transfers.remove(id, erase);
  else if (kind == QStringLiteral("share"))
    app_.sharing.remove(id, erase);
  else {
    app_.direct.remove(id);
    if (erase)
      eraseRetained(row);
  }
  emit changed();
}
void StorageManager::move(const QString &kind, const QString &id, const QString &base) {
  if (kind == QStringLiteral("torrent")) {
    app_.transfers.relocateMissing(id, base);
    return;
  }
  if (kind != QStringLiteral("direct") && kind != QStringLiteral("share"))
    return;
  const auto key = kind + QLatin1Char(':') + id;
  if (!app_.store.get(QStringLiteral("file-move"), key).isEmpty()) {
    retryMove(key);
    return;
  }
  for (auto v : inventory())
    if (v.toObject().value(QStringLiteral("key")).toString() == key &&
        v.toObject().value(QStringLiteral("inUse")).toBool())
      throw AppError(QStringLiteral("STORAGE_BUSY"),
                     QStringLiteral("Stop playback and pause this transfer before moving it."));
  if (kind == QStringLiteral("share"))
    app_.sharing.prepareMove(id);
  else
    app_.direct.pause(id);
  auto row = app_.store.get(field(kind), id);
  if (!owned::file(row, row.value(QStringLiteral("path")).toString()))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("Cannot move an external or unavailable copy."));
  auto next = row;
  const auto destination = owned::allocate(base, id, row.value(QStringLiteral("nonce")).toString());
  next.insert(QStringLiteral("root"), destination);
  next.insert(QStringLiteral("path"),
              QDir(destination).filePath(QFileInfo(row.value(QStringLiteral("path")).toString()).fileName()));
  QJsonObject journal{{QStringLiteral("id"), key},
                      {QStringLiteral("kind"), kind},
                      {QStringLiteral("source"), row},
                      {QStringLiteral("destination"), next}};
  QJsonObject originals;
  for (const auto &path : files(row))
    if (QFileInfo::exists(path)) {
      const QFileInfo info(path);
      originals.insert(info.fileName(),
                       QJsonObject{{QStringLiteral("size"), info.size()},
                                   {QStringLiteral("mtime"), info.lastModified().toMSecsSinceEpoch()}});
    }
  journal.insert(QStringLiteral("originals"), originals);
  row.insert(QStringLiteral("moving"), true);
  app_.store.transaction([&] {
    app_.store.put(QStringLiteral("file-move"), key, journal);
    app_.store.put(field(kind), id, row);
  });
  if (kind == QStringLiteral("share"))
    app_.sharing.reload(id);
  else
    app_.direct.reload(id);
  runMove(journal);
}
void StorageManager::retryMove(const QString &key) {
  const auto journal = app_.store.get(QStringLiteral("file-move"), key);
  if (journal.isEmpty())
    return;
  if (journal.value(QStringLiteral("committed")).toBool())
    finishMove(journal);
  else
    runMove(journal);
}
void StorageManager::runMove(const QJsonObject &journal) {
  const auto key = journal.value(QStringLiteral("id")).toString();
  if (moving_.contains(key))
    return;
  moving_.insert(key);
  const auto stop = stop_;
  const auto reserve =
      qint64(app_.transfers.configuration().value(QStringLiteral("reserveMiB")).toInt(1024)) * 1024 * 1024;
  auto *watcher = new QFutureWatcher<MoveResult>(this);
  connect(watcher, &QFutureWatcher<MoveResult>::finished, this, [this, watcher, journal, key] {
    moving_.remove(key);
    const auto result = watcher->result();
    const auto error = result.error;
    watcher->deleteLater();
    if (error.isEmpty()) {
      try {
        auto next = journal;
        next.insert(QStringLiteral("committed"), true);
        next.insert(QStringLiteral("hashes"), result.hashes);
        auto row = journal.value(QStringLiteral("destination")).toObject();
        row.insert(QStringLiteral("moving"), false);
        auto file = row.value(QStringLiteral("file")).toObject();
        if (!file.isEmpty()) {
          file.insert(QStringLiteral("path"), row.value(QStringLiteral("path")));
          file.insert(QStringLiteral("id"),
                      QString::fromLatin1(
                          QCryptographicHash::hash(file.value(QStringLiteral("path")).toString().toUtf8(),
                                                   QCryptographicHash::Sha256)
                              .toHex()));
          file.insert(
              QStringLiteral("mtime"),
              QFileInfo(file.value(QStringLiteral("path")).toString()).lastModified().toMSecsSinceEpoch());
          row.insert(QStringLiteral("file"), file);
        }
        app_.store.transaction([&] {
          app_.store.put(field(journal.value(QStringLiteral("kind")).toString()),
                         row.value(QStringLiteral("id")).toString(), row);
          app_.store.put(QStringLiteral("file-move"), key, next);
        });
        finishMove(next);
      } catch (const AppError &e) {
        emit problem(e.code(), e.message());
      }
    } else if (!stop_->load())
      emit problem(
          QStringLiteral("STORAGE_MOVE"),
          error + QStringLiteral(" The move is saved; use Retry storage moves after fixing the problem."));
    emit changed();
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [journal, stop, reserve]() -> MoveResult {
    MoveResult result;
    const auto source = journal.value(QStringLiteral("source")).toObject(),
               destination = journal.value(QStringLiteral("destination")).toObject();
    if (!owned::directory(source) || !owned::directory(destination))
      return QStringLiteral("A storage folder is unavailable or its ownership changed.");
    for (const auto &path : files(source)) {
      if (!QFileInfo::exists(path))
        continue;
      if (!owned::file(source, path))
        return QStringLiteral("The source file path changed.");
      const QFileInfo before(path);
      const auto original =
          journal.value(QStringLiteral("originals")).toObject().value(before.fileName()).toObject();
      if (original.isEmpty() || original.value(QStringLiteral("size")).toInteger() != before.size() ||
          original.value(QStringLiteral("mtime")).toInteger() != before.lastModified().toMSecsSinceEpoch())
        return QStringLiteral("The original file changed after the move was requested.");
      const auto target =
          QDir(destination.value(QStringLiteral("root")).toString()).filePath(before.fileName());
      if (!owned::file(destination, target))
        return QStringLiteral("The destination path changed.");
      const auto sha = digest(path, stop);
      if (sha.isEmpty())
        return QStringLiteral("Cannot read the source file.");
      result.hashes.insert(before.fileName(), QString::fromLatin1(sha.toHex()));
      if (QFileInfo::exists(target)) {
        if (digest(target, stop) == sha)
          continue;
        return QStringLiteral("The destination contains different data; it was kept.");
      }
      QFile input(path);
      QSaveFile output(target);
      if (!input.open(QIODevice::ReadOnly) || !output.open(QIODevice::WriteOnly))
        return QStringLiteral("Cannot open the storage move files.");
      while (!input.atEnd()) {
        if (stop->load())
          return QStringLiteral("Move interrupted.");
        QStorageInfo disk(destination.value(QStringLiteral("root")).toString());
        if (disk.isValid() && disk.bytesAvailable() >= 0 && disk.bytesAvailable() < reserve + 2 * 1024 * 1024)
          return QStringLiteral("The free-space reserve was reached.");
        const auto bytes = input.read(1024 * 1024);
        if (bytes.isEmpty() || output.write(bytes) != bytes.size())
          return QStringLiteral("Could not copy the file.");
      }
      if (before.size() != QFileInfo(path).size() ||
          before.lastModified() != QFileInfo(path).lastModified() || !output.commit() ||
          digest(target, stop) != sha)
        return QStringLiteral("The copied file could not be verified. Original data was kept.");
    }
    return result;
  }));
}
void StorageManager::finishMove(const QJsonObject &journal) {
  const auto key = journal.value(QStringLiteral("id")).toString();
  if (moving_.contains(key))
    return;
  const auto kind = journal.value(QStringLiteral("kind")).toString();
  const auto destination = app_.store.get(
      field(kind),
      journal.value(QStringLiteral("destination")).toObject().value(QStringLiteral("id")).toString());
  const auto id = destination.value(QStringLiteral("id")).toString();
  if (kind == QStringLiteral("share"))
    app_.sharing.reload(id);
  else
    app_.direct.reload(id);
  const auto file = destination.value(QStringLiteral("file")).toObject();
  if (LibraryService::unchanged(file))
    app_.library.registerIdentified(file);
  const auto source = journal.value(QStringLiteral("source")).toObject();
  if (!owned::directory(destination))
    throw AppError(
        QStringLiteral("STORAGE_OWNERSHIP"),
        QStringLiteral(
            "The committed destination is unavailable. Restore it before cleaning the old files."));
  if (!QFileInfo::exists(source.value(QStringLiteral("root")).toString())) {
    app_.store.remove(QStringLiteral("file-move"), journal.value(QStringLiteral("id")).toString());
    return;
  }
  if (!owned::directory(source))
    throw AppError(
        QStringLiteral("STORAGE_OWNERSHIP"),
        QStringLiteral("Move committed; the old folder needs ownership verification before cleanup."));
  moving_.insert(key);
  const auto stop = stop_;
  auto *watcher = new QFutureWatcher<QString>(this);
  connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, key, source] {
    moving_.remove(key);
    const auto error = watcher->result();
    watcher->deleteLater();
    if (error.isEmpty())
      app_.perform([&] {
        app_.store.remove(QStringLiteral("file-move"), key);
        app_.library.refreshAvailability(source.value(QStringLiteral("root")).toString());
      });
    else if (!stop_->load())
      emit problem(QStringLiteral("STORAGE_DELETE"), error);
    emit changed();
  });
  watcher->setFuture(QtConcurrent::run(&pool_, [source, destination, journal, stop] {
    for (const auto &path : files(source))
      if (QFileInfo::exists(path)) {
        const QFileInfo info(path);
        const auto original =
            journal.value(QStringLiteral("originals")).toObject().value(info.fileName()).toObject();
        const auto expected = QByteArray::fromHex(
            journal.value(QStringLiteral("hashes")).toObject().value(info.fileName()).toString().toLatin1());
        const auto target =
            QDir(destination.value(QStringLiteral("root")).toString()).filePath(info.fileName());
        if (!owned::file(source, path) || !owned::file(destination, target) || original.isEmpty() ||
            expected.size() != 32 || info.size() != original.value(QStringLiteral("size")).toInteger() ||
            info.lastModified().toMSecsSinceEpoch() != original.value(QStringLiteral("mtime")).toInteger() ||
            digest(path, stop) != expected || digest(target, stop) != expected || stop->load() ||
            !QFile::remove(path))
          return QStringLiteral("Move committed; an old or destination file changed or could not be checked. "
                                "Originals were kept. Retry storage moves after reviewing the folders.");
      }
    pruneMarker(source);
    return QString();
  }));
}
void StorageManager::configure(const QJsonObject &policy) {
  for (const auto &key : {QStringLiteral("days"), QStringLiteral("capacityMiB")})
    if (policy.value(key).toDouble(-1) < 0 || policy.value(key).toDouble() > 2147483647)
      throw AppError(QStringLiteral("STORAGE_POLICY"),
                     QStringLiteral("Cleanup limits must be non-negative."));
  app_.store.setSetting(QStringLiteral("cleanup"), policy);
  emit changed();
}
QJsonArray StorageManager::candidates(const QJsonArray &inventory) const {
  const auto policy = app_.store.setting(QStringLiteral("cleanup")).toObject();
  const auto days = policy.value(QStringLiteral("days")).toInt();
  const auto capacity = qint64(policy.value(QStringLiteral("capacityMiB")).toInteger()) * 1024 * 1024;
  auto ordered = inventory.toVariantList();
  std::sort(ordered.begin(), ordered.end(), [](const QVariant &a, const QVariant &b) {
    return a.toJsonObject().value(QStringLiteral("lastUsed")).toInteger() <
           b.toJsonObject().value(QStringLiteral("lastUsed")).toInteger();
  });
  qint64 total = 0;
  for (auto v : inventory)
    total += v.toObject().value(QStringLiteral("bytes")).toInteger();
  QHash<QString, qint64> needed;
  QJsonArray result;
  for (auto value : ordered) {
    const auto row = value.toJsonObject();
    if (!row.value(QStringLiteral("owned")).toBool() || !row.value(QStringLiteral("eligible")).toBool() ||
        row.value(QStringLiteral("pinned")).toBool() || row.value(QStringLiteral("inUse")).toBool() ||
        row.value(QStringLiteral("moving")).toBool() || row.value(QStringLiteral("bytes")).toInteger() <= 0)
      continue;
    QStorageInfo disk(row.value(QStringLiteral("root")).toString());
    const auto device = QString::fromUtf8(disk.device());
    if (!needed.contains(device))
      needed.insert(
          device,
          std::max<qint64>(
              0, qint64(app_.transfers.configuration().value(QStringLiteral("reserveMiB")).toInt(1024)) *
                         1024 * 1024 -
                     disk.bytesAvailable()));
    const auto bytes = row.value(QStringLiteral("bytes")).toInteger();
    const bool aged = days > 0 && row.value(QStringLiteral("lastUsed")).toInteger() > 0 &&
                      row.value(QStringLiteral("lastUsed")).toInteger() <
                          QDateTime::currentMSecsSinceEpoch() - qint64(days) * 86400000;
    if (!aged && !(capacity > 0 && total > capacity) &&
        !(policy.value(QStringLiteral("freeReserve")).toBool() && needed.value(device) > 0))
      continue;
    result.append(row);
    total -= bytes;
    needed[device] -= bytes;
  }
  return result;
}
void StorageManager::automatic() {
  if (!app_.store.setting(QStringLiteral("cleanup")).toObject().value(QStringLiteral("enabled")).toBool() ||
      scanning_)
    return;
  automatic_ = true;
  refresh();
}
} // namespace wp
