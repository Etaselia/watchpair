#include "sharing_service.h"
#include "owned_storage.h"
#include <QCollator>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QFutureWatcher>
#include <QJsonDocument>
#include <QSaveFile>
#include <QStorageInfo>
#include <QUuid>
#include <QtConcurrent>
#include <algorithm>
#ifdef Q_OS_WIN
#include <io.h>
#else
#include <unistd.h>
#endif
namespace wp {
namespace {
QString uuid() {
  return QUuid::createUuid().toString(QUuid::WithoutBraces);
}
qint64 now() {
  return QDateTime::currentMSecsSinceEpoch();
}
QString localKey(const QString &room, const QString &source) {
  return room + QLatin1Char(':') + source;
}
QString assetId(const QJsonObject &asset) {
  return QStringLiteral("sha256:") + asset.value(QStringLiteral("sha256")).toString();
}
QJsonObject publicAsset(const QJsonObject &file) {
  return {{QStringLiteral("fileIndex"), file.value(QStringLiteral("index"))},
          {QStringLiteral("path"), file.value(QStringLiteral("relative"))},
          {QStringLiteral("size"), file.value(QStringLiteral("size"))},
          {QStringLiteral("sha256"), file.value(QStringLiteral("sha256"))},
          {QStringLiteral("merkleRoot"), file.value(QStringLiteral("merkleRoot"))},
          {QStringLiteral("kind"), TransferEngine::video(file.value(QStringLiteral("relative")).toString())
                                       ? QStringLiteral("video")
                                       : QStringLiteral("subtitle")}};
}
bool subtitle(const QString &path) {
  return QStringList{QStringLiteral("srt"), QStringLiteral("ass"), QStringLiteral("ssa"),
                     QStringLiteral("vtt"), QStringLiteral("sub"), QStringLiteral("idx")}
      .contains(QFileInfo(path).suffix().toLower());
}
QString portable(QString path) {
  QStringList parts;
  for (auto part : path.split(QLatin1Char('/'))) {
    part.replace(QLatin1Char('%'), QStringLiteral("%25"));
    part.replace(QLatin1Char(':'), QStringLiteral("%3A"));
    part.replace(QLatin1Char('\\'), QStringLiteral("%5C"));
    for (int i = 0; i < part.size(); ++i)
      if (part[i].unicode() < 32)
        part.replace(i, 1, QStringLiteral("_"));
    parts.append(part);
  }
  return parts.join(QLatin1Char('/'));
}
bool sync(QFile &file) {
  if (!file.flush())
    return false;
#ifdef Q_OS_WIN
  return _commit(file.handle()) == 0;
#else
  return ::fsync(file.handle()) == 0;
#endif
}
QJsonObject error(const QString &message) {
  return {{QStringLiteral("error"), message}};
}
} // namespace
SharedFileSource::SharedFileSource(SharingService &service, QString id)
    : service_(service), id_(std::move(id)) {
}
QList<TorrentFile> SharedFileSource::files() const {
  const auto &r = service_.job(id_).row;
  return {{0, r.value(QStringLiteral("label")).toString(), r.value(QStringLiteral("size")).toInteger(), 0}};
}
bool SharedFileSource::selected(int i) const {
  return i == 0 && !service_.job(id_).row.value(QStringLiteral("removed")).toBool();
}
bool SharedFileSource::paused() const {
  const auto &j = service_.job(id_);
  return j.row.value(QStringLiteral("manualPaused")).toBool() || j.restoring ||
         !j.row.value(QStringLiteral("error")).toString().isEmpty();
}
bool SharedFileSource::hasPiece(int piece) const {
  const auto &j = service_.job(id_);
  return j.verified.contains(piece) && service_.owns(j.row) &&
         QFileInfo(j.row.value(QStringLiteral("path")).toString()).isFile() &&
         !QFileInfo(j.row.value(QStringLiteral("path")).toString()).isSymLink();
}
void SharedFileSource::requestPiece(int piece, int deadline) {
  auto &j = service_.job(id_);
  if (piece >= 0 && pieceSize(piece) > 0 && !hasPiece(piece))
    j.priorities.insert(piece, deadline);
}
void SharedFileSource::cancelDeadline(int piece) {
  service_.job(id_).priorities.remove(piece);
}
int SharedFileSource::pieceSize(int piece) const {
  return piece >= 0 && qint64(piece) * sharing::ChunkSize < totalSize()
             ? int(std::min<qint64>(sharing::ChunkSize, totalSize() - qint64(piece) * sharing::ChunkSize))
             : 0;
}
qint64 SharedFileSource::totalSize() const {
  return service_.job(id_).row.value(QStringLiteral("size")).toInteger();
}
void SharedFileSource::readerOpened() {
  ++service_.job(id_).readers;
}
void SharedFileSource::readerClosed() {
  auto &j = service_.job(id_);
  j.readers = std::max(0, j.readers - 1);
}
void SharedFileSource::readPiece(int piece) {
  auto &j = service_.job(id_);
  if (!hasPiece(piece)) {
    emit pieceRead(piece, {}, QStringLiteral("The shared chunk is unavailable."));
    return;
  }
  const auto path = j.row.value(QStringLiteral("path")).toString();
  const auto expected = j.verified.value(piece);
  const int length = pieceSize(piece);
  auto *watcher = new QFutureWatcher<QByteArray>(this);
  connect(watcher, &QFutureWatcher<QByteArray>::finished, this, [this, watcher, piece, expected] {
    const auto data = watcher->result();
    watcher->deleteLater();
    if (sharing::leaf(data) != expected) {
      emit pieceRead(piece, {}, QStringLiteral("A verified shared chunk changed on disk."));
      return;
    }
    emit pieceRead(piece, data, {});
  });
  watcher->setFuture(QtConcurrent::run(&service_.disk_, [path, piece, length] {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || !file.seek(qint64(piece) * sharing::ChunkSize))
      return QByteArray();
    return file.read(length);
  }));
}
SharingService::SharingService(LocalStore &store, RoomClient &rooms, RoomMedia &media,
                               LibraryService &library, TransferEngine &transfers, QObject *parent)
    : QObject(parent), store_(store), rooms_(rooms), media_(media), library_(library), transfers_(transfers),
      transport_(store, rooms, transfers) {
  preparation_.setMaxThreadCount(2);
  disk_.setMaxThreadCount(2);
  seeding_.setMaxThreadCount(2);
  media_.setSharedBinding([this](const QString &room, const QJsonObject &source, const QJsonObject &entry) {
    return binding(room, source, entry);
  });
  connect(&transport_, &ShareTransport::received, this, &SharingService::received);
  connect(&transport_, &ShareTransport::changed, this, &SharingService::changed);
  connect(&transport_, &ShareTransport::problem, this, [this](const QString &room, const QString &message) {
    emit problem(room, QStringLiteral("SHARING_NETWORK"), message);
  });
  connect(&rooms_, &RoomClient::operationComplete, this, [this](const QString &room, const QString &op) {
    try {
      finishPublication(op);
    } catch (const AppError &e) {
      emit problem(room, e.code(), e.message());
    }
  });
  connect(&rooms_, &RoomClient::queueChanged, this, [this] { reconciled_ = 0; });
  connect(&media_, &RoomMedia::changed, this, [this] { reconciled_ = 0; });
  connect(&rooms_, &RoomClient::roomRemoved, this, [this](const QString &room) {
    for (const auto &op : preparationRooms_.keys())
      if (preparationRooms_.value(op) == room && preparing_.contains(op))
        preparing_.value(op)->store(true);
    for (auto value : store_.find(QStringLiteral("share-offer"), QStringLiteral("room"), room))
      store_.remove(QStringLiteral("share-offer"), value.toObject().value(QStringLiteral("id")).toString());
    reconcile();
  });
  connect(&library_, &LibraryService::identified, this, [this](const QString &op, const QJsonObject &file) {
    if (!identifying_.contains(op))
      return;
    const auto key = identifying_.take(op);
    auto it = jobs_.find(key);
    if (it == jobs_.end())
      return;
    auto &j = *it->second;
    j.verifying = false;
    if (file.value(QStringLiteral("sha256")) != j.row.value(QStringLiteral("sha256")) ||
        file.value(QStringLiteral("size")) != j.row.value(QStringLiteral("size"))) {
      failed(j, QStringLiteral("The completed copy did not match its shared fingerprint."));
      return;
    }
    auto next = j.row;
    next.insert(QStringLiteral("file"), file);
    next.insert(QStringLiteral("state"), QStringLiteral("Ready"));
    try {
      persist(j, next);
    } catch (const AppError &e) {
      failed(j, e.message());
    }
    emit changed();
  });
  auto reuse = [this] {
    reusable_.clear();
    for (auto value : library_.files()) {
      const auto f = value.toObject();
      if (!f.value(QStringLiteral("missing")).toBool())
        reusable_.insert(f.value(QStringLiteral("sha256")).toString());
    }
  };
  connect(&library_, &LibraryService::changed, this, reuse);
  reuse();
  connect(&library_, &LibraryService::failed, this, [this](const QString &op, const QString &message) {
    if (!identifying_.contains(op))
      return;
    const auto id = identifying_.take(op);
    auto it = jobs_.find(id);
    if (it != jobs_.end()) {
      it->second->verifying = false;
      failed(*it->second, message);
    }
  });
  for (auto value : store_.all(QStringLiteral("share-download"))) {
    auto r = value.toObject();
    auto j = std::make_unique<Job>();
    j->row = r;
    const auto key = r.value(QStringLiteral("id")).toString();
    j->source = std::make_unique<SharedFileSource>(*this, key);
    auto *raw = j.get();
    jobs_.emplace(key, std::move(j));
    if (!r.value(QStringLiteral("removed")).toBool())
      restore(*raw);
  }
  connect(&timer_, &QTimer::timeout, this, &SharingService::tick);
  timer_.start(250);
}
SharingService::~SharingService() {
  stopping_->store(true);
  timer_.stop();
  media_.setSharedBinding({});
  for (auto stop : preparing_)
    stop->store(true);
  preparation_.waitForDone();
  disk_.waitForDone();
  seeding_.waitForDone();
}
QJsonObject SharingService::bundle(const QString &id) const {
  if (!bundles_.contains(id)) {
    const auto b = store_.get(QStringLiteral("share-bundle"), id);
    bundles_.insert(id, b);
    QHash<int, QJsonObject> files;
    for (auto v : b.value(QStringLiteral("files")).toArray()) {
      const auto file = v.toObject();
      files.insert(file.value(QStringLiteral("index")).toInt(), file);
      publisherBySha_.insert(file.value(QStringLiteral("sha256")).toString(), file);
    }
    bundleFiles_.insert(id, files);
  }
  return bundles_.value(id);
}
QString SharingService::prepare(const QString &path, const QString &room) {
  if (!rooms_.connected(room))
    throw AppError(QStringLiteral("ROOM_OFFLINE"),
                   QStringLiteral("Connect to the room before preparing a shared source."));
  const auto operation = uuid();
  auto stop = std::make_shared<std::atomic_bool>(false);
  preparing_.insert(operation, stop);
  preparationRooms_.insert(operation, room);
  emit progress(operation, QStringLiteral("Identifying files and preparing verified chunks…"));
  auto *watcher = new QFutureWatcher<QJsonObject>(this);
  connect(watcher, &QFutureWatcher<QJsonObject>::finished, this, [this, watcher, operation, room] {
    const auto result = watcher->result();
    watcher->deleteLater();
    preparing_.remove(operation);
    preparationRooms_.remove(operation);
    QTimer::singleShot(0, this, [this, operation] { emit preparationFinished(operation); });
    if (store_.get(QStringLiteral("room-private"), room).isEmpty())
      return;
    if (result.isEmpty()) {
      emit problem(room, QStringLiteral("CANCELLED"), QStringLiteral("Share preparation cancelled."));
      return;
    }
    if (result.contains(QStringLiteral("error"))) {
      emit problem(room, QStringLiteral("SHARE_PREPARATION"),
                   result.value(QStringLiteral("error")).toString());
      return;
    }
    try {
      auto value = result;
      value.insert(QStringLiteral("id"), operation);
      value.insert(QStringLiteral("room"), room);
      store_.put(QStringLiteral("share-bundle"), operation, value);
      emit prepared(value);
    } catch (const AppError &e) {
      emit problem(room, e.code(), e.message());
    }
  });
  watcher->setFuture(QtConcurrent::run(&preparation_, [path, stop] {
    try {
      const QFileInfo input(path);
      if (input.isSymLink() || !input.exists())
        return error(QStringLiteral("Choose an accessible actual file or folder."));
      QStringList paths;
      const auto base = input.isDir() ? input.canonicalFilePath() : input.absolutePath();
      if (input.isDir()) {
        QDirIterator scan(base, QDir::Files | QDir::NoSymLinks | QDir::Readable,
                          QDirIterator::Subdirectories);
        while (scan.hasNext()) {
          if (stop->load())
            return QJsonObject();
          const auto file = scan.next();
          if (TransferEngine::video(file) || subtitle(file))
            paths.append(file);
          if (paths.size() > 20000)
            return error(QStringLiteral("Share at most 20,000 media and subtitle files at once."));
        }
      } else
        paths.append(input.canonicalFilePath());
      QCollator order;
      order.setNumericMode(true);
      std::sort(paths.begin(), paths.end(),
                [&](const auto &a, const auto &b) { return order.compare(a, b) < 0; });
      QJsonArray files, assets;
      int index = 0;
      for (const auto &file : paths) {
        if (!TransferEngine::video(file) && !subtitle(file))
          continue;
        auto relative = portable(QDir(base).relativeFilePath(file));
        if (relative.size() > 2048)
          return error(QStringLiteral("A shared file path exceeds the room manifest limit."));
        auto identified = sharing::identify(file, relative, index++, stop);
        if (identified.isEmpty())
          return QJsonObject();
        files.append(identified);
        assets.append(publicAsset(identified));
      }
      if (files.isEmpty())
        return error(QStringLiteral("The selection has no supported videos or subtitles."));
      const auto digest = QCryptographicHash::hash(QJsonDocument(assets).toJson(QJsonDocument::Compact),
                                                   QCryptographicHash::Sha256)
                              .toHex();
      return QJsonObject{
          {QStringLiteral("label"), input.isDir() ? input.fileName() : input.completeBaseName()},
          {QStringLiteral("files"), files},
          {QStringLiteral("assets"), assets},
          {QStringLiteral("identity"), QStringLiteral("share:") + QString::fromLatin1(digest)}};
    } catch (const std::exception &e) {
      return error(QString::fromUtf8(e.what()));
    }
  }));
  return operation;
}
void SharingService::cancelPreparation(const QString &id) {
  if (preparing_.contains(id))
    preparing_.value(id)->store(true);
}
QString SharingService::publishSubtitle(const QString &bundleId, const QString &room, int index,
                                        int generation) {
  const auto b = bundle(bundleId);
  const auto file = bundleFiles_.value(bundleId).value(index);
  if (!subtitle(file.value(QStringLiteral("relative")).toString()))
    throw AppError(QStringLiteral("SUBTITLE_FILE"), QStringLiteral("Choose a subtitle file."));
  const auto member = rooms_.credential(room).value(QStringLiteral("memberId")).toString(),
             identity = b.value(QStringLiteral("identity")).toString(),
             sourceId = identity + QLatin1Char(':') + member;
  const QJsonObject source{{QStringLiteral("id"), sourceId},
                           {QStringLiteral("kind"), QStringLiteral("share")},
                           {QStringLiteral("label"), b.value(QStringLiteral("label")).toString().left(300)},
                           {QStringLiteral("uri"), QString()},
                           {QStringLiteral("identity"), identity},
                           {QStringLiteral("publisherId"), member},
                           {QStringLiteral("assets"), b.value(QStringLiteral("assets"))}};
  return rooms_.command(
      room, {{QStringLiteral("type"), QStringLiteral("source.add")}, {QStringLiteral("source"), source}},
      [&](const QString &op) {
        store_.put(QStringLiteral("share-publication"), op,
                   {{QStringLiteral("id"), op},
                    {QStringLiteral("room"), room},
                    {QStringLiteral("source"), sourceId},
                    {QStringLiteral("bundle"), bundleId},
                    {QStringLiteral("attachIndex"), index},
                    {QStringLiteral("attachGeneration"), generation}});
      });
}
QString SharingService::subtitleFile(const QString &room, const QString &key) {
  if (!key.startsWith(QStringLiteral("ext:")))
    return {};
  const auto sha = key.mid(4);
  bool published = false;
  for (auto value : rooms_.room(room).value(QStringLiteral("sources")).toArray())
    for (auto asset : value.toObject().value(QStringLiteral("assets")).toArray())
      if (asset.toObject().value(QStringLiteral("sha256")).toString() == sha &&
          asset.toObject().value(QStringLiteral("kind")).toString() == QStringLiteral("subtitle"))
        published = true;
  if (!published)
    return {};
  const auto file = library_.match(sha);
  if (LibraryService::unchanged(file))
    return file.value(QStringLiteral("path")).toString();
  if (!publisherBySha_.contains(sha))
    for (auto value : store_.find(QStringLiteral("share-offer"), QStringLiteral("room"), room))
      bundle(value.toObject().value(QStringLiteral("bundle")).toString());
  const auto original = publisherBySha_.value(sha);
  if (LibraryService::unchanged(original))
    return original.value(QStringLiteral("path")).toString();
  return {};
}
QString SharingService::publish(const QString &bundleId, const QString &room, const QList<int> &selected,
                                qint64 revision) {
  const auto b = bundle(bundleId);
  if (b.isEmpty())
    throw AppError(QStringLiteral("SHARE_MANIFEST"), QStringLiteral("Prepare this source again."));
  const auto member = rooms_.credential(room).value(QStringLiteral("memberId")).toString(),
             identity = b.value(QStringLiteral("identity")).toString(),
             sourceId = identity + QLatin1Char(':') + member;
  const QSet<int> choices(selected.begin(), selected.end());
  QJsonArray files;
  for (auto value : b.value(QStringLiteral("assets")).toArray()) {
    const auto f = value.toObject();
    if (f.value(QStringLiteral("kind")).toString() != QStringLiteral("video"))
      continue;
    const auto path = f.value(QStringLiteral("path")).toString();
    files.append(QJsonObject{
        {QStringLiteral("mediaId"),
         RoomMedia::mediaId(identity, f.value(QStringLiteral("fileIndex")).toInt())},
        {QStringLiteral("path"), path},
        {QStringLiteral("label"), QFileInfo(path).completeBaseName().left(300)},
        {QStringLiteral("fileIndex"), f.value(QStringLiteral("fileIndex"))},
        {QStringLiteral("size"), f.value(QStringLiteral("size"))},
        {QStringLiteral("duration"), QJsonValue::Null},
        {QStringLiteral("selected"), choices.contains(f.value(QStringLiteral("fileIndex")).toInt())},
        {QStringLiteral("sha256"), f.value(QStringLiteral("sha256"))},
        {QStringLiteral("merkleRoot"), f.value(QStringLiteral("merkleRoot"))}});
  }
  if (files.isEmpty() || choices.isEmpty())
    throw AppError(QStringLiteral("SHARE_SELECTION"),
                   QStringLiteral("Choose at least one video for the room."));
  const QJsonObject source{{QStringLiteral("id"), sourceId},
                           {QStringLiteral("kind"), QStringLiteral("share")},
                           {QStringLiteral("label"), b.value(QStringLiteral("label")).toString().left(300)},
                           {QStringLiteral("uri"), QString()},
                           {QStringLiteral("identity"), identity},
                           {QStringLiteral("publisherId"), member},
                           {QStringLiteral("assets"), b.value(QStringLiteral("assets"))}};
  return rooms_.command(
      room,
      {{QStringLiteral("type"), QStringLiteral("queue.add")},
       {QStringLiteral("source"), source},
       {QStringLiteral("files"), files}},
      [&](const QString &op) {
        store_.put(QStringLiteral("share-publication"), op,
                   {{QStringLiteral("id"), op},
                    {QStringLiteral("room"), room},
                    {QStringLiteral("source"), sourceId},
                    {QStringLiteral("bundle"), bundleId}});
      },
      revision >= 0 ? QJsonObject{{QStringLiteral("queueRevision"), revision}} : QJsonObject());
}
void SharingService::finishPublication(const QString &operation) {
  const auto row = store_.get(QStringLiteral("share-publication"), operation);
  if (row.isEmpty())
    return;
  const auto room = row.value(QStringLiteral("room")).toString();
  if (store_.get(QStringLiteral("room-private"), room).isEmpty()) {
    store_.remove(QStringLiteral("share-publication"), operation);
    return;
  }
  auto value = row;
  value.insert(QStringLiteral("id"), localKey(room, row.value(QStringLiteral("source")).toString()));
  store_.transaction([&] {
    store_.put(QStringLiteral("share-offer"), value.value(QStringLiteral("id")).toString(), value);
    store_.remove(QStringLiteral("share-publication"), operation);
  });
  QJsonArray identified;
  for (auto v :
       bundle(row.value(QStringLiteral("bundle")).toString()).value(QStringLiteral("files")).toArray()) {
    auto file = v.toObject();
    file.insert(QStringLiteral("label"), QFileInfo(file.value(QStringLiteral("path")).toString()).fileName());
    file.insert(
        QStringLiteral("id"),
        QString::fromLatin1(QCryptographicHash::hash(file.value(QStringLiteral("path")).toString().toUtf8(),
                                                     QCryptographicHash::Sha256)
                                .toHex()));
    for (const auto &field : {QStringLiteral("chunks"), QStringLiteral("relative"), QStringLiteral("index"),
                              QStringLiteral("merkleRoot")})
      file.remove(field);
    identified.append(file);
  }
  library_.registerIdentified(identified);
  attachSubtitle(value);
  emit changed();
}
void SharingService::attachSubtitle(const QJsonObject &row) {
  if (!row.contains(QStringLiteral("attachIndex")) || row.contains(QStringLiteral("attachOperation")) ||
      row.value(QStringLiteral("attachExpired")).toBool())
    return;
  const auto room = row.value(QStringLiteral("room")).toString();
  if (!rooms_.connected(room))
    return;
  const auto value = row;
  bundle(row.value(QStringLiteral("bundle")).toString());
  if (rooms_.room(room).value(QStringLiteral("playback")).toObject().value(QStringLiteral("generation")) !=
      row.value(QStringLiteral("attachGeneration"))) {
    auto expired = row;
    expired.insert(QStringLiteral("attachExpired"), true);
    store_.put(QStringLiteral("share-offer"), row.value(QStringLiteral("id")).toString(), expired);
    emit problem(room, QStringLiteral("SUBTITLE_TIMELINE_CHANGED"),
                 QStringLiteral("The episode changed during subtitle preparation. Select the shared subtitle "
                                "again for the current episode."));
    return;
  }
  const auto file = bundleFiles_.value(row.value(QStringLiteral("bundle")).toString())
                        .value(row.value(QStringLiteral("attachIndex")).toInt());
  const auto p = rooms_.room(room).value(QStringLiteral("playback")).toObject();
  rooms_.command(
      room,
      {{QStringLiteral("type"), QStringLiteral("tracks.select")},
       {QStringLiteral("audio"), p.value(QStringLiteral("audio"))},
       {QStringLiteral("subtitle"), QStringLiteral("ext:") + file.value(QStringLiteral("sha256")).toString()},
       {QStringLiteral("subtitleDelay"), p.value(QStringLiteral("subtitleDelay"))}},
      [&](const QString &op) {
        auto next = value;
        next.insert(QStringLiteral("attachOperation"), op);
        store_.put(QStringLiteral("share-offer"), value.value(QStringLiteral("id")).toString(), next);
      },
      {{QStringLiteral("generation"), row.value(QStringLiteral("attachGeneration"))}});
}
SharingService::Job &SharingService::job(const QString &id) const {
  auto it = jobs_.find(id);
  if (it == jobs_.end())
    throw AppError(QStringLiteral("SHARE_MISSING"), QStringLiteral("This shared download was removed."));
  return *it->second;
}
bool SharingService::owns(const QJsonObject &row) const {
  return owned::file(row, row.value(QStringLiteral("path")).toString());
}
SharingService::Job &SharingService::ensure(const Demand &demand) {
  const auto key = assetId(demand.asset);
  auto it = jobs_.find(key);
  if (it != jobs_.end())
    return *it->second;
  auto j = std::make_unique<Job>();
  const auto nonce = uuid();
  const auto base = transfers_.configuration()
                        .value(QStringLiteral("downloadRoot"))
                        .toString(store_.profile() + QStringLiteral("/downloads"));
  const auto root = QDir(base).absoluteFilePath(QStringLiteral("watchpair-share-") + uuid());
  if (QFileInfo::exists(root) || !QDir().mkpath(root) || QFileInfo(root).isSymLink())
    throw AppError(QStringLiteral("SHARE_STORAGE"),
                   QStringLiteral("Cannot allocate an owned shared-download folder."));
  QSaveFile marker(root + QStringLiteral("/.watchpair-owner"));
  const auto bytes = QJsonDocument(QJsonObject{{QStringLiteral("id"), key}, {QStringLiteral("nonce"), nonce}})
                         .toJson(QJsonDocument::Compact);
  if (!marker.open(QIODevice::WriteOnly) || marker.write(bytes) != bytes.size() || !marker.commit())
    throw AppError(QStringLiteral("SHARE_STORAGE"),
                   QStringLiteral("Could not record shared folder ownership."));
  auto suffix = QFileInfo(demand.asset.value(QStringLiteral("path")).toString()).suffix();
  if (suffix.size() > 10 || suffix.isEmpty())
    suffix = QStringLiteral("bin");
  j->row = {
      {QStringLiteral("id"), key},
      {QStringLiteral("root"), QDir(root).canonicalPath()},
      {QStringLiteral("nonce"), nonce},
      {QStringLiteral("path"), QDir(root).canonicalPath() + QStringLiteral("/media.") + suffix},
      {QStringLiteral("label"), QFileInfo(demand.asset.value(QStringLiteral("path")).toString()).fileName()},
      {QStringLiteral("size"), demand.asset.value(QStringLiteral("size"))},
      {QStringLiteral("sha256"), demand.asset.value(QStringLiteral("sha256"))},
      {QStringLiteral("merkleRoot"), demand.asset.value(QStringLiteral("merkleRoot"))},
      {QStringLiteral("state"), QStringLiteral("Waiting")},
      {QStringLiteral("manualPaused"), false},
      {QStringLiteral("pinned"), false}};
  store_.put(QStringLiteral("share-download"), key, j->row);
  j->source = std::make_unique<SharedFileSource>(*this, key);
  auto *raw = j.get();
  jobs_.emplace(key, std::move(j));
  return *raw;
}
void SharingService::persist(Job &j, QJsonObject value) {
  store_.put(QStringLiteral("share-download"), value.value(QStringLiteral("id")).toString(), value);
  j.row = std::move(value);
}
void SharingService::failed(Job &j, const QString &message) {
  auto next = j.row;
  next.insert(QStringLiteral("error"), message);
  next.insert(QStringLiteral("state"), QStringLiteral("Error"));
  try {
    persist(j, next);
  } catch (const AppError &) {
    j.row = next;
  }
  j.pending = -1;
  j.operation.clear();
  emit j.source->stateChanged();
  emit problem(j.room, QStringLiteral("SHARE_DOWNLOAD"), message);
  emit changed();
}
void SharingService::restore(Job &j) {
  if (!owns(j.row)) {
    failed(j, QStringLiteral("The shared download folder is missing or its ownership changed. Restore the "
                             "drive or remove this download while keeping its files."));
    return;
  }
  j.restoring = true;
  const auto key = j.row.value(QStringLiteral("id")).toString(),
             path = j.row.value(QStringLiteral("path")).toString();
  const auto size = j.row.value(QStringLiteral("size")).toInteger();
  const auto expected = QByteArray::fromHex(j.row.value(QStringLiteral("merkleRoot")).toString().toLatin1());
  const auto pieces = store_.find(QStringLiteral("share-piece"), QStringLiteral("download"), key);
  auto *watcher = new QFutureWatcher<QList<QPair<int, QByteArray>>>(this);
  connect(watcher, &QFutureWatcher<QList<QPair<int, QByteArray>>>::finished, this, [this, watcher, key] {
    const auto result = watcher->result();
    watcher->deleteLater();
    auto it = jobs_.find(key);
    if (it == jobs_.end())
      return;
    auto &j = *it->second;
    for (const auto &piece : result)
      j.verified.insert(piece.first, piece.second);
    j.verifiedBytes = 0;
    for (auto it = j.verified.begin(); it != j.verified.end(); ++it)
      j.verifiedBytes += j.source->pieceSize(it.key());
    j.restoring = false;
    emit j.source->stateChanged();
    emit changed();
  });
  const auto stop = stopping_;
  watcher->setFuture(QtConcurrent::run(&disk_, [path, size, expected, pieces, stop] {
    QList<QPair<int, QByteArray>> valid;
    QFile input(path);
    if (!input.open(QIODevice::ReadOnly))
      return valid;
    const int count = int((size + sharing::ChunkSize - 1) / sharing::ChunkSize);
    for (auto value : pieces) {
      if (stop->load())
        break;
      const auto row = value.toObject();
      const int index = row.value(QStringLiteral("index")).toInt(-1);
      if (index < 0 || index >= count || !input.seek(qint64(index) * sharing::ChunkSize))
        continue;
      const auto data =
          input.read(std::min<qint64>(sharing::ChunkSize, size - qint64(index) * sharing::ChunkSize));
      if (sharing::verify(data, index, count, row.value(QStringLiteral("proof")).toArray(), expected))
        valid.append({index, sharing::leaf(data)});
    }
    return valid;
  }));
}
void SharingService::reconcile() {
  if (reconciling_)
    return;
  reconciling_ = true;
  reconciled_ = now();
  demands_.clear();
  demandOrder_.clear();
  for (auto row : rooms_.rooms()) {
    const auto room = row.toObject().value(QStringLiteral("key")).toString();
    const auto snapshot = rooms_.room(room);
    QHash<QString, QJsonObject> sources;
    QHash<QString, QHash<int, QJsonObject>> assets;
    for (auto value : snapshot.value(QStringLiteral("sources")).toArray()) {
      const auto source = value.toObject();
      if (source.value(QStringLiteral("kind")).toString() != QStringLiteral("share"))
        continue;
      const auto sourceId = source.value(QStringLiteral("id")).toString();
      sources.insert(sourceId, source);
      for (auto item : source.value(QStringLiteral("assets")).toArray())
        assets[sourceId].insert(item.toObject().value(QStringLiteral("fileIndex")).toInt(), item.toObject());
    }
    QHash<QString, QJsonObject> policies;
    for (auto it = sources.begin(); it != sources.end(); ++it)
      policies.insert(it.key(), media_.acquisition(room, it.key()));
    int ordinal = 0;
    for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
      const int order = ordinal++;
      const auto entry = value.toObject();
      const auto sourceId = entry.value(QStringLiteral("sourceId")).toString(),
                 publisher = sources.value(sourceId).value(QStringLiteral("publisherId")).toString();
      if (publisher.isEmpty() ||
          publisher == rooms_.credential(room).value(QStringLiteral("memberId")).toString())
        continue;
      const auto asset = assets.value(sourceId).value(entry.value(QStringLiteral("fileIndex")).toInt(-1));
      if (asset.isEmpty() || asset.value(QStringLiteral("sha256")) != entry.value(QStringLiteral("sha256")) ||
          asset.value(QStringLiteral("merkleRoot")) != entry.value(QStringLiteral("merkleRoot")) ||
          asset.value(QStringLiteral("size")) != entry.value(QStringLiteral("size")))
        continue;
      const auto policy = policies.value(sourceId);
      bool approved = false;
      for (auto m : policy.value(QStringLiteral("approved")).toArray())
        if (m == entry.value(QStringLiteral("mediaId")))
          approved = true;
      const auto effective = policy.value(QStringLiteral("effectivePolicy")).toString();
      const bool wanted =
          entry.value(QStringLiteral("enabled")).toBool() &&
          (effective == QStringLiteral("Auto") || (effective == QStringLiteral("Ask") && approved));
      demands_[assetId(asset)].append({room, sourceId, publisher, asset, wanted});
      const int rank =
          entry.value(QStringLiteral("id")) ==
                  snapshot.value(QStringLiteral("playback")).toObject().value(QStringLiteral("entryId"))
              ? -10
              : order;
      demandOrder_.insert(assetId(asset), std::min(demandOrder_.value(assetId(asset), INT_MAX), rank));
    }
    const auto subtitleKey =
        snapshot.value(QStringLiteral("playback")).toObject().value(QStringLiteral("subtitle")).toString();
    if (subtitleKey.startsWith(QStringLiteral("ext:")))
      for (auto it = sources.begin(); it != sources.end(); ++it) {
        const auto policy = policies.value(it.key()), source = it.value();
        const auto effective = policy.value(QStringLiteral("effectivePolicy")).toString();
        if (source.value(QStringLiteral("publisherId")) ==
            rooms_.credential(room).value(QStringLiteral("memberId")))
          continue;
        bool watching = false;
        for (auto member : snapshot.value(QStringLiteral("members")).toArray())
          if (member.toObject().value(QStringLiteral("id")) ==
              rooms_.credential(room).value(QStringLiteral("memberId"))) {
            const auto w = member.toObject().value(QStringLiteral("watch")).toString();
            watching = w == QStringLiteral("active") || w == QStringLiteral("staging");
          }
        for (auto asset : assets.value(it.key()))
          if (QStringLiteral("ext:") + asset.value(QStringLiteral("sha256")).toString() == subtitleKey &&
              asset.value(QStringLiteral("kind")).toString() == QStringLiteral("subtitle")) {
            const bool allowed =
                effective == QStringLiteral("Auto") ||
                (effective == QStringLiteral("Ask") &&
                 (!policy.value(QStringLiteral("approved")).toArray().isEmpty() ||
                  (watching && asset.value(QStringLiteral("size")).toInteger() <= 16 * 1024 * 1024)));
            demands_[assetId(asset)].append(
                {room, it.key(), source.value(QStringLiteral("publisherId")).toString(), asset, allowed});
            demandOrder_.insert(assetId(asset), -20);
          }
      }
  }
  reconciling_ = false;
}
MediaBinding SharingService::binding(const QString &room, const QJsonObject &source,
                                     const QJsonObject &entry) {
  const auto sha = entry.value(QStringLiteral("sha256")).toString();
  const auto key = QStringLiteral("sha256:") + sha;
  const auto offer = store_.get(QStringLiteral("share-offer"),
                                localKey(room, source.value(QStringLiteral("id")).toString()));
  if (!offer.isEmpty()) {
    const auto bundleId = offer.value(QStringLiteral("bundle")).toString();
    bundle(bundleId);
    auto file = bundleFiles_.value(bundleId).value(entry.value(QStringLiteral("fileIndex")).toInt(-1));
    if (file.value(QStringLiteral("sha256")) != entry.value(QStringLiteral("sha256")) ||
        file.value(QStringLiteral("size")) != entry.value(QStringLiteral("size")) ||
        !LibraryService::unchanged(file))
      return {{},
              -1,
              {},
              {},
              {},
              QStringLiteral("The publisher's original file changed or is missing. Restore the original or "
                             "prepare it as a new source.")};
    file.insert(QStringLiteral("label"), QFileInfo(file.value(QStringLiteral("path")).toString()).fileName());
    if (!publisherSources_.contains(key))
      publisherSources_.emplace(key, std::make_unique<LocalFileSource>(file));
    return {publisherSources_.at(key).get(),
            0,
            entry.value(QStringLiteral("mediaId")).toString(),
            {},
            file.value(QStringLiteral("path")).toString(),
            {}};
  }
  if (!demands_.contains(key) || now() - reconciled_ > 1000)
    reconcile();
  Demand selected;
  for (const auto &d : demands_.value(key))
    if (d.room == room && d.source == source.value(QStringLiteral("id")).toString()) {
      selected = d;
      break;
    }
  if (!selected.wanted)
    return {{},
            -1,
            {},
            {},
            {},
            QStringLiteral("Approve this shared episode's download on this device, or locate its exact local "
                           "copy.")};
  auto &j = ensure(selected);
  if (j.row.value(QStringLiteral("removed")).toBool())
    return {
        {}, -1,
        {}, {},
        {}, QStringLiteral("You removed this shared download. Resume it from Transfers to download again.")};
  if (j.restoring || !j.row.value(QStringLiteral("error")).toString().isEmpty())
    return {{},
            -1,
            {},
            {},
            {},
            j.restoring ? QStringLiteral("Checking previously verified shared chunks…")
                        : j.row.value(QStringLiteral("error"))
                              .toString(j.row.value(QStringLiteral("manualPaused")).toBool()
                                            ? QStringLiteral("Shared download paused by you.")
                                            : QStringLiteral("Waiting for shared download"))};
  return {j.source.get(),
          0,
          entry.value(QStringLiteral("mediaId")).toString(),
          {},
          {},
          j.row.value(QStringLiteral("manualPaused")).toBool()
              ? QStringLiteral("Shared download paused by you. Resume it when more data is needed.")
              : QString()};
}
void SharingService::complete(Job &j) {
  if (j.verifying || j.row.value(QStringLiteral("state")).toString() == QStringLiteral("Ready"))
    return;
  j.verifying = true;
  auto next = j.row;
  next.insert(QStringLiteral("state"), QStringLiteral("Verifying"));
  persist(j, next);
  identifying_.insert(library_.identify(j.row.value(QStringLiteral("path")).toString()),
                      j.row.value(QStringLiteral("id")).toString());
}
void SharingService::tick() {
  try {
    for (auto value : store_.all(QStringLiteral("share-publication"))) {
      const auto row = value.toObject();
      const auto op = row.value(QStringLiteral("id")).toString();
      const auto pending = store_.get(QStringLiteral("room-command"), op);
      if (pending.isEmpty())
        finishPublication(op);
      else if (pending.value(QStringLiteral("state")).toString() != QStringLiteral("pending"))
        store_.remove(QStringLiteral("share-publication"), op);
    }
    if (now() - reconciled_ > 1000) {
      reconcile();
      for (auto value : store_.all(QStringLiteral("share-offer")))
        attachSubtitle(value.toObject());
    }
    for (auto it = replies_.begin(); it != replies_.end();) {
      auto &reply = it.value();
      if (!rooms_.connected(reply.room) || !offering(reply.room, reply.source) ||
          (!reply.pending && now() - reply.sent > 120000)) {
        serving_.remove(it.key());
        it = replies_.erase(it);
        continue;
      }
      if (reply.pending && transport_.send(reply.room, reply.peer, reply.message)) {
        reply.pending = false;
        reply.sent = now();
        serving_.remove(it.key());
      }
      ++it;
    }
    int downloadSlots =
        std::clamp(transfers_.configuration().value(QStringLiteral("concurrency")).toInt(3), 1, 8);
    auto pending = demands_.keys();
    std::sort(pending.begin(), pending.end(), [this](const QString &a, const QString &b) {
      return demandOrder_.value(a, INT_MAX) < demandOrder_.value(b, INT_MAX);
    });
    for (const auto &pendingId : pending) {
      if (int(jobs_.size()) >= 10000)
        break;
      if (jobs_.contains(pendingId) || reusable_.contains(pendingId.mid(7)))
        continue;
      bool ready = false;
      for (const auto &d : demands_.value(pendingId))
        if (d.wanted && rooms_.connected(d.room)) {
          ready = true;
          break;
        }
      if (!ready)
        continue;
      int busy = 0;
      for (const auto &[existingId, j] : jobs_)
        if (!j->row.value(QStringLiteral("manualPaused")).toBool() &&
            j->row.value(QStringLiteral("state")).toString() != QStringLiteral("Ready") &&
            !j->row.value(QStringLiteral("removed")).toBool() &&
            j->row.value(QStringLiteral("error")).toString().isEmpty())
          for (const auto &d : demands_.value(existingId))
            if (d.wanted) {
              ++busy;
              break;
            }
      if (busy >= downloadSlots)
        break;
      for (const auto &d : demands_.value(pendingId))
        if (d.wanted) {
          ensure(d);
          break;
        }
    }
    for (const auto &[id, j] : jobs_) {
      bool wanted = false;
      for (const auto &d : demands_.value(id))
        wanted = wanted || (d.wanted && rooms_.connected(d.room));
      const bool eligible = wanted && !j->restoring && !j->verifying &&
                            !j->row.value(QStringLiteral("manualPaused")).toBool() &&
                            !j->row.value(QStringLiteral("removed")).toBool() &&
                            !j->row.value(QStringLiteral("moving")).toBool() &&
                            j->row.value(QStringLiteral("error")).toString().isEmpty() &&
                            j->row.value(QStringLiteral("state")).toString() != QStringLiteral("Ready");
      transfers_.setExternalWork(QStringLiteral("share:") + id, eligible,
                                 j->readers > 0 || !j->priorities.isEmpty());
    }
    int active = 0;
    const bool offline = transfers_.configuration().value(QStringLiteral("offline")).toBool();
    QList<Job *> ordered;
    for (const auto &[_, ptr] : jobs_)
      ordered.append(ptr.get());
    std::stable_sort(ordered.begin(), ordered.end(), [this](Job *a, Job *b) {
      const auto rank = [this](Job *j) {
        return j->readers > 0 || !j->priorities.isEmpty()
                   ? -30
                   : demandOrder_.value(j->row.value(QStringLiteral("id")).toString(), INT_MAX);
      };
      return rank(a) < rank(b);
    });
    for (auto *ptr : ordered) {
      auto &j = *ptr;
      const auto key = j.row.value(QStringLiteral("id")).toString();
      if (j.bytesAt == 0) {
        j.bytesAt = now();
        j.bytesLast = j.verifiedBytes;
      }
      if (now() - j.bytesAt >= 1000) {
        j.rate = int(double(j.verifiedBytes - j.bytesLast) * 1000 / (now() - j.bytesAt));
        j.bytesAt = now();
        j.bytesLast = j.verifiedBytes;
      }
      if (j.restoring || j.writing || j.verifying || j.row.value(QStringLiteral("removed")).toBool() ||
          j.row.value(QStringLiteral("moving")).toBool() ||
          j.row.value(QStringLiteral("manualPaused")).toBool() ||
          !j.row.value(QStringLiteral("error")).toString().isEmpty())
        continue;
      const auto size = j.row.value(QStringLiteral("size")).toInteger();
      const int count = int((size + sharing::ChunkSize - 1) / sharing::ChunkSize);
      if (j.verified.size() == count) {
        complete(j);
        continue;
      }
      Demand demand;
      for (const auto &d : demands_.value(key))
        if (d.wanted && rooms_.connected(d.room)) {
          demand = d;
          break;
        }
      if (demand.room.isEmpty() || offline || active >= downloadSlots ||
          !transfers_.hasDownloadSlot(QStringLiteral("share:") + key)) {
        j.row.insert(QStringLiteral("state"),
                     demand.room.isEmpty() || offline ? QStringLiteral("Waiting") : QStringLiteral("Queued"));
        continue;
      }
      ++active;
      j.room = demand.room;
      j.peer = demand.publisher;
      if (j.pending >= 0) {
        const int limit = transfers_.externalDownLimit();
        const qint64 timeout =
            limit > 0 ? std::max<qint64>(20000, qint64(sharing::ChunkSize) * 1000 / std::max(1, limit) * 3)
                      : 20000;
        if (now() - j.requested < timeout)
          continue;
        // A relay may still be receiving a slow publisher upload. Retrying
        // the same request preserves its eventual response instead of making
        // every late verified chunk obsolete under a new operation ID.
        if (transport_.send(demand.room, demand.publisher,
                            {{QStringLiteral("type"), QStringLiteral("get")},
                             {QStringLiteral("request"), j.operation},
                             {QStringLiteral("source"), demand.source},
                             {QStringLiteral("fileIndex"), demand.asset.value(QStringLiteral("fileIndex"))},
                             {QStringLiteral("piece"), j.pending}}))
          j.requested = now();
        continue;
      }
      if (now() < j.retry)
        continue;
      QStorageInfo disk(j.row.value(QStringLiteral("root")).toString());
      if (disk.isValid() && disk.bytesAvailable() >= 0 &&
          disk.bytesAvailable() <
              qint64(transfers_.configuration().value(QStringLiteral("reserveMiB")).toInt(1024)) * 1024 *
                      1024 +
                  sharing::ChunkSize) {
        j.row.insert(QStringLiteral("state"), QStringLiteral("Waiting for disk space"));
        continue;
      }
      int piece = -1, priority = INT_MAX;
      for (auto it = j.priorities.begin(); it != j.priorities.end(); ++it)
        if (it.key() >= 0 && it.key() < count && !j.verified.contains(it.key()) && it.value() < priority) {
          piece = it.key();
          priority = it.value();
        }
      if (piece < 0)
        for (int i = 0; i < count; ++i)
          if (!j.verified.contains(i)) {
            piece = i;
            break;
          }
      const auto operation = uuid();
      if (transport_.send(demand.room, demand.publisher,
                          {{QStringLiteral("type"), QStringLiteral("get")},
                           {QStringLiteral("request"), operation},
                           {QStringLiteral("source"), demand.source},
                           {QStringLiteral("fileIndex"), demand.asset.value(QStringLiteral("fileIndex"))},
                           {QStringLiteral("piece"), piece}})) {
        j.pending = piece;
        j.operation = operation;
        j.requested = now();
        j.row.insert(QStringLiteral("state"), QStringLiteral("Downloading"));
      } else
        j.row.insert(QStringLiteral("state"), QStringLiteral("Waiting"));
    }
    transport_.setActive(active, serving_.size());
    emit changed();
  } catch (const AppError &e) {
    reconciling_ = false;
    emit problem({}, e.code(), e.message());
  }
}
void SharingService::received(const QString &room, const QString &peer, const QJsonObject &message) {
  try {
    const auto type = message.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("get")) {
      serve(room, peer, message);
      return;
    }
    const auto request = message.value(QStringLiteral("request")).toString();
    for (auto &[_, ptr] : jobs_) {
      auto &j = *ptr;
      if (!request.isEmpty() && j.operation == request && j.room == room && j.peer == peer) {
        if (type == QStringLiteral("chunk"))
          accept(j, message);
        else if (type == QStringLiteral("unavailable")) {
          j.pending = -1;
          j.retry = now() + 5000;
          j.row.insert(QStringLiteral("state"), QStringLiteral("Waiting for publisher"));
        }
        break;
      }
    }
  } catch (const AppError &e) {
    emit problem(room, e.code(), e.message());
  }
}
void SharingService::serve(const QString &room, const QString &peer, const QJsonObject &request) {
  const auto requestId = request.value(QStringLiteral("request")).toString(),
             sourceId = request.value(QStringLiteral("source")).toString();
  const int piece = request.value(QStringLiteral("piece")).toInt(-1),
            index = request.value(QStringLiteral("fileIndex")).toInt(-1);
  const auto slot = room + QLatin1Char(':') + peer + QLatin1Char(':') + requestId;
  if (requestId.size() != 36 || piece < 0 || index < 0 || serving_.contains(slot) || serving_.size() >= 8 ||
      transfers_.configuration().value(QStringLiteral("offline")).toBool())
    return;
  const auto offer = store_.get(QStringLiteral("share-offer"), localKey(room, sourceId));
  if (offer.value(QStringLiteral("disabled")).toBool()) {
    transport_.send(
        room, peer,
        {{QStringLiteral("type"), QStringLiteral("unavailable")}, {QStringLiteral("request"), requestId}});
    return;
  }
  const auto bundleId = offer.value(QStringLiteral("bundle")).toString();
  bundle(bundleId);
  const auto file = bundleFiles_.value(bundleId).value(index);
  bool permitted = false;
  for (auto value : rooms_.room(room).value(QStringLiteral("sources")).toArray())
    if (value.toObject().value(QStringLiteral("id")).toString() == sourceId &&
        value.toObject().value(QStringLiteral("publisherId")).toString() ==
            rooms_.credential(room).value(QStringLiteral("memberId")).toString())
      permitted = true;
  if (!permitted || file.isEmpty() || !LibraryService::unchanged(file) ||
      qint64(piece) * sharing::ChunkSize >= file.value(QStringLiteral("size")).toInteger()) {
    transport_.send(
        room, peer,
        {{QStringLiteral("type"), QStringLiteral("unavailable")}, {QStringLiteral("request"), requestId}});
    return;
  }
  if (replies_.contains(slot)) {
    auto &reply = replies_[slot];
    if (now() - reply.sent > 2000)
      reply.pending = true;
    return;
  }
  if (replies_.size() >= 16) {
    auto oldest = replies_.end();
    for (auto it = replies_.begin(); it != replies_.end(); ++it)
      if (!it->pending && (oldest == replies_.end() || it->sent < oldest->sent))
        oldest = it;
    if (oldest == replies_.end())
      return;
    replies_.erase(oldest);
  }
  requests_.insert(slot, now());
  for (auto it = requests_.begin(); it != requests_.end();)
    if (now() - it.value() > 60000)
      it = requests_.erase(it);
    else
      ++it;
  serving_.insert(slot);
  transport_.setActive(1, serving_.size());
  auto *watcher = new QFutureWatcher<QJsonObject>(this);
  connect(watcher, &QFutureWatcher<QJsonObject>::finished, this,
          [this, watcher, slot, room, peer, requestId, sourceId] {
            const auto result = watcher->result();
            watcher->deleteLater();
            if (!rooms_.connected(room) || !offering(room, sourceId)) {
              serving_.remove(slot);
              return;
            }
            auto message = result;
            message.insert(QStringLiteral("type"), result.contains(QStringLiteral("data"))
                                                       ? QStringLiteral("chunk")
                                                       : QStringLiteral("unavailable"));
            message.insert(QStringLiteral("request"), requestId);
            replies_.insert(slot, Reply{room, peer, sourceId, message, 0, true});
            transport_.setActive(0, serving_.size());
          });
  watcher->setFuture(QtConcurrent::run(&seeding_, [this, file, piece] {
    QFile input(file.value(QStringLiteral("path")).toString());
    if (!input.open(QIODevice::ReadOnly) || !input.seek(qint64(piece) * sharing::ChunkSize))
      return QJsonObject();
    const auto data =
        input.read(std::min<qint64>(sharing::ChunkSize, file.value(QStringLiteral("size")).toInteger() -
                                                            qint64(piece) * sharing::ChunkSize));
    const auto tree = treeFor(file);
    if (!tree || tree->isEmpty() || piece >= tree->first().size() ||
        sharing::leaf(data) != tree->first()[piece])
      return QJsonObject();
    return QJsonObject{{QStringLiteral("data"), QString::fromLatin1(data.toBase64())},
                       {QStringLiteral("piece"), piece},
                       {QStringLiteral("proof"), sharing::proof(*tree, piece)}};
  }));
}
void SharingService::accept(Job &j, const QJsonObject &message) {
  if (j.writing || j.pending < 0 || j.row.value(QStringLiteral("manualPaused")).toBool() ||
      j.row.value(QStringLiteral("removed")).toBool())
    return;
  const int piece = message.value(QStringLiteral("piece")).toInt(-1);
  const auto size = j.row.value(QStringLiteral("size")).toInteger();
  const int count = int((size + sharing::ChunkSize - 1) / sharing::ChunkSize);
  const auto data = QByteArray::fromBase64(message.value(QStringLiteral("data")).toString().toLatin1());
  const auto proof = message.value(QStringLiteral("proof")).toArray();
  if (piece != j.pending || data.size() != j.source->pieceSize(piece) ||
      !sharing::verify(
          data, piece, count, proof,
          QByteArray::fromHex(j.row.value(QStringLiteral("merkleRoot")).toString().toLatin1()))) {
    failed(j, QStringLiteral("A received chunk did not match the shared manifest. No unverified bytes were "
                             "exposed to the player."));
    return;
  }
  if (!owns(j.row) || QFileInfo(j.row.value(QStringLiteral("path")).toString()).isSymLink()) {
    failed(j, QStringLiteral("The shared download's owned storage changed."));
    return;
  }
  j.writing = true;
  const auto key = j.row.value(QStringLiteral("id")).toString(),
             path = j.row.value(QStringLiteral("path")).toString();
  auto *watcher = new QFutureWatcher<bool>(this);
  connect(watcher, &QFutureWatcher<bool>::finished, this, [this, watcher, key, piece, data, proof] {
    const bool written = watcher->result();
    watcher->deleteLater();
    auto it = jobs_.find(key);
    if (it == jobs_.end())
      return;
    auto &j = *it->second;
    j.writing = false;
    j.pending = -1;
    j.operation.clear();
    if (!written) {
      failed(j, QStringLiteral("Could not commit a shared chunk. Check disk space and folder permissions."));
      return;
    }
    try {
      store_.put(QStringLiteral("share-piece"), key + QLatin1Char(':') + QString::number(piece),
                 {{QStringLiteral("download"), key},
                  {QStringLiteral("index"), piece},
                  {QStringLiteral("proof"), proof}});
      if (!j.verified.contains(piece))
        j.verifiedBytes += j.source->pieceSize(piece);
      j.verified.insert(piece, sharing::leaf(data));
      j.priorities.remove(piece);
      emit j.source->pieceAvailable(piece);
      emit changed();
    } catch (const AppError &e) {
      failed(j, e.message());
    }
  });
  watcher->setFuture(QtConcurrent::run(&disk_, [path, piece, data] {
    QFile out(path);
    return !QFileInfo(path).isSymLink() && out.open(QIODevice::ReadWrite) &&
           out.seek(qint64(piece) * sharing::ChunkSize) && out.write(data) == data.size() && sync(out);
  }));
}
QJsonArray SharingService::downloads() const {
  QJsonArray out;
  for (const auto &[key, ptr] : jobs_) {
    const auto &j = *ptr;
    auto row = j.row;
    row.insert(QStringLiteral("received"), j.verifiedBytes);
    row.insert(QStringLiteral("total"), row.value(QStringLiteral("size")));
    row.insert(QStringLiteral("downRate"), j.rate);
    row.insert(QStringLiteral("inUse"), j.readers > 0 || j.writing || j.verifying);
    row.insert(QStringLiteral("transport"), j.room.isEmpty() ? QString() : transport_.mode(j.room, j.peer));
    row.insert(QStringLiteral("kind"), QStringLiteral("share"));
    const auto order =
        transfers_.queueOrder(QStringLiteral("share:") + row.value(QStringLiteral("id")).toString());
    row.insert(QStringLiteral("order"), order == INT_MAX ? -1 : order);
    out.append(row);
  }
  return out;
}
std::shared_ptr<const sharing::MerkleTree> SharingService::treeFor(const QJsonObject &file) {
  const auto root = file.value(QStringLiteral("merkleRoot")).toString();
  {
    std::lock_guard<std::mutex> guard(treeMutex_);
    if (trees_.contains(root))
      return trees_.value(root);
  }
  auto next = std::make_shared<sharing::MerkleTree>(sharing::tree(sharing::hashes(file)));
  if (next->isEmpty() || QString::fromLatin1(next->last().first().toHex()) != root)
    return {};
  const qint64 cost = qint64(next->first().size()) * 128;
  if (cost > 128 * 1024 * 1024)
    return next;
  std::lock_guard<std::mutex> guard(treeMutex_);
  if (trees_.contains(root))
    return trees_.value(root);
  while (!treeOrder_.isEmpty() && treeCost_ + cost > 128 * 1024 * 1024) {
    const auto old = treeOrder_.takeFirst();
    treeCost_ -= qint64(trees_.value(old)->first().size()) * 128;
    trees_.remove(old);
  }
  trees_.insert(root, next);
  treeOrder_.append(root);
  treeCost_ += cost;
  return next;
}
void SharingService::pause(const QString &id) {
  auto &j = job(id);
  auto next = j.row;
  next.insert(QStringLiteral("manualPaused"), true);
  next.insert(QStringLiteral("state"), QStringLiteral("Paused"));
  persist(j, next);
  j.pending = -1;
  j.operation.clear();
  emit j.source->stateChanged();
  emit changed();
}
void SharingService::resume(const QString &id) {
  auto &j = job(id);
  j.pending = -1;
  j.operation.clear();
  j.retry = 0;
  auto next = j.row;
  next.insert(QStringLiteral("manualPaused"), false);
  next.insert(QStringLiteral("removed"), false);
  next.insert(QStringLiteral("error"), QString());
  next.insert(QStringLiteral("state"), QStringLiteral("Waiting"));
  persist(j, next);
  if (!owns(j.row))
    failed(j, QStringLiteral("Restore the owned folder before retrying this shared download."));
  emit j.source->stateChanged();
  emit changed();
}
void SharingService::pin(const QString &id, bool pinned) {
  auto &j = job(id);
  auto next = j.row;
  next.insert(QStringLiteral("pinned"), pinned);
  persist(j, next);
  emit changed();
}
bool SharingService::offering(const QString &room, const QString &source) const {
  const auto offer = store_.get(QStringLiteral("share-offer"), localKey(room, source));
  if (offer.isEmpty() || offer.value(QStringLiteral("disabled")).toBool())
    return false;
  const auto self = rooms_.credential(room).value(QStringLiteral("memberId"));
  for (auto value : rooms_.room(room).value(QStringLiteral("sources")).toArray()) {
    const auto row = value.toObject();
    if (row.value(QStringLiteral("id")).toString() == source &&
        row.value(QStringLiteral("publisherId")) == self)
      return true;
  }
  return false;
}
void SharingService::setOffering(const QString &room, const QString &source, bool enabled) {
  const auto key = localKey(room, source);
  auto offer = store_.get(QStringLiteral("share-offer"), key);
  if (offer.isEmpty())
    throw AppError(QStringLiteral("SHARE_OFFER"),
                   QStringLiteral("Prepare and publish this source on this device first."));
  offer.insert(QStringLiteral("disabled"), !enabled);
  store_.put(QStringLiteral("share-offer"), key, offer);
  emit changed();
}
bool SharingService::busy(const QString &id) const {
  const auto &j = job(id);
  return j.readers || j.writing || j.verifying || j.restoring;
}
void SharingService::prepareMove(const QString &id) {
  auto &j = job(id);
  if (j.readers || j.writing || j.verifying || j.restoring)
    throw AppError(QStringLiteral("STORAGE_BUSY"),
                   QStringLiteral("Stop playback and wait for disk work before moving this copy."));
  pause(id);
}
void SharingService::reload(const QString &id) {
  auto &j = job(id);
  j.row = store_.get(QStringLiteral("share-download"), id);
  emit j.source->stateChanged();
  emit changed();
}
void SharingService::remove(const QString &id, bool erase) {
  auto &j = job(id);
  if (j.readers || j.writing || j.verifying || j.row.value(QStringLiteral("moving")).toBool() ||
      j.row.value(QStringLiteral("pinned")).toBool())
    throw AppError(QStringLiteral("STORAGE_IN_USE"),
                   QStringLiteral("Stop playback and unpin this copy before removing it."));
  if (erase && !owns(j.row))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("The shared folder ownership cannot be verified. Its files were kept."));
  pause(id);
  auto next = j.row;
  next.insert(QStringLiteral("removed"), true);
  next.insert(QStringLiteral("state"), QStringLiteral("Removed · files kept"));
  persist(j, next);
  if (erase) {
    const auto path = j.row.value(QStringLiteral("path")).toString();
    if (QFileInfo(path).isSymLink() || (QFileInfo::exists(path) && !QFile::remove(path)))
      throw AppError(QStringLiteral("STORAGE_DELETE"),
                     QStringLiteral("The managed shared copy could not be deleted."));
    for (auto value : store_.find(QStringLiteral("share-piece"), QStringLiteral("download"), id)) {
      const auto piece = value.toObject().value(QStringLiteral("index")).toInt();
      store_.remove(QStringLiteral("share-piece"), id + QLatin1Char(':') + QString::number(piece));
    }
    j.verified.clear();
    j.verifiedBytes = 0;
    next.insert(QStringLiteral("state"), QStringLiteral("Removed · copy deleted"));
    persist(j, next);
  }
  emit changed();
}
} // namespace wp
