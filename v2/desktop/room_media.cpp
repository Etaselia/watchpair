#include "room_media.h"
#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QTimer>
#include <QUuid>
namespace wp {
namespace {
QString indexKey(const QString &transfer, int index) {
  return transfer + QLatin1Char(':') + QString::number(index);
}
QString fileName(QString label) {
  label.replace(QLatin1Char('\\'), QLatin1Char('_'));
  label.replace(QLatin1Char(':'), QLatin1Char('_'));
  label.replace(QLatin1Char('/'), QLatin1Char('_'));
  return label.isEmpty() ? QStringLiteral("media.mp4") : label;
}
QString manifestPath(const QString &path) {
  QString result;
  for (const auto c : path) {
    if (c == QLatin1Char(':') || c == QLatin1Char('\\') || c == QLatin1Char('%') || c.unicode() < 32)
      result += QString::fromLatin1(QUrl::toPercentEncoding(QString(c)));
    else
      result += c;
  }
  return result;
}
QString label(QString text) {
  text.remove(QRegularExpression(QStringLiteral("[\\x00-\\x1f\\x7f]")));
  text = text.trimmed().left(300);
  return text.isEmpty() ? QStringLiteral("Media") : text;
}
} // namespace
RoomMedia::RoomMedia(LocalStore &store, RoomClient &rooms, TransferEngine &transfers,
                     SourceResolver &resolver, LibraryService &library, DirectDownloads &direct,
                     QObject *parent)
    : QObject(parent), store_(store), rooms_(rooms), transfers_(transfers), resolver_(resolver),
      library_(library), direct_(direct) {
  connect(&resolver_, &SourceResolver::resolved, this, &RoomMedia::resolved);
  connect(&resolver_, &SourceResolver::failed, this,
          [this](const QString &op, const QString &code, const QString &message) {
            if (!resolving_.contains(op))
              return;
            const auto work = resolving_.take(op);
            sourceRequests_.remove(work.value(QStringLiteral("binding")).toString());
            emit error(work.value(QStringLiteral("room")).toString(), code, message);
          });
  connect(&rooms_, &RoomClient::queueChanged, this, &RoomMedia::reconcile);
  connect(&rooms_, &RoomClient::connectionChanged, this, [this](const QString &room) {
    if (rooms_.connected(room))
      reconcile(room);
  });
  connect(&rooms_, &RoomClient::roomRemoved, this, &RoomMedia::forgetRoom);
  connect(
      &transfers_, &TransferEngine::manifestReady, this,
      [this](const QString &id) {
        identityCache_.clear();
        QHash<int, TorrentFile> files;
        if (auto *source = transfers_.source(id))
          for (const auto &f : source->files())
            files.insert(f.index, f);
        manifests_.insert(id, files);
        for (auto value : rooms_.rooms())
          reconcile(value.toObject().value(QStringLiteral("key")).toString());
      },
      Qt::QueuedConnection);
  connect(&transfers_, &TransferEngine::fileComplete, this,
          [this](const QString &id, int index) { queueIdentification(id, index); });
  connect(&transfers_, &TransferEngine::fileReadyForIdentification, this, &RoomMedia::identify);
  connect(&transfers_, &TransferEngine::identificationUnavailable, this,
          [this](const QString &id, int index) {
            const auto token = preparingIdentification_.take(indexKey(id, index));
            if (!token.isEmpty())
              transfers_.releaseHold(id, token);
          });
  connect(&transfers_, &TransferEngine::removed, this, [this](const QString &id) {
    manifests_.remove(id);
    identityCache_.clear();
    removedAcquisition(QStringLiteral("transfer"), id);
  });
  connect(&library_, &LibraryService::changed, this, &RoomMedia::libraryChanged);
  connect(&library_, &LibraryService::identified, this, [this](const QString &op, QJsonObject file) {
    if (!identifying_.contains(op))
      return;
    const auto work = identifying_.take(op);
    const auto transfer = work.value(QStringLiteral("transfer")).toString();
    try {
      if (transfer.isEmpty()) {
        if (!work.value(QStringLiteral("room")).toString().isEmpty() &&
            store_.get(QStringLiteral("room-private"), work.value(QStringLiteral("room")).toString())
                .isEmpty())
          return;
        auto result = work;
        result.insert(QStringLiteral("file"), file);
        result.insert(QStringLiteral("kind"), QStringLiteral("local"));
        emit prepared(result);
        return;
      }
      const int index = work.value(QStringLiteral("index")).toInt();
      library_.tag(file.value(QStringLiteral("id")).toString(),
                   {{QStringLiteral("managedTransfer"), transfer}, {QStringLiteral("managedIndex"), index}});
      file = library_.file(file.value(QStringLiteral("id")).toString());
      store_.put(QStringLiteral("torrent-file"), indexKey(transfer, index),
                 {{QStringLiteral("transfer"), transfer},
                  {QStringLiteral("index"), index},
                  {QStringLiteral("file"), file}});
      identifiedFiles_.insert(indexKey(transfer, index), file);
      hashing_.remove(indexKey(transfer, index));
      transfers_.releaseHold(transfer, op);
      for (auto value : rooms_.rooms())
        publishFingerprints(value.toObject().value(QStringLiteral("key")).toString());
    } catch (const AppError &e) {
      if (!transfer.isEmpty()) {
        hashing_.remove(indexKey(transfer, work.value(QStringLiteral("index")).toInt()));
        transfers_.releaseHold(transfer, op);
      }
      emit error(work.value(QStringLiteral("room")).toString(), e.code(), e.message());
    }
  });
  connect(&library_, &LibraryService::failed, this, [this](const QString &op, const QString &message) {
    if (!identifying_.contains(op))
      return;
    const auto work = identifying_.take(op);
    const auto transfer = work.value(QStringLiteral("transfer")).toString();
    if (!transfer.isEmpty()) {
      hashing_.remove(indexKey(transfer, work.value(QStringLiteral("index")).toInt()));
      transfers_.releaseHold(transfer, op);
    }
    emit error(work.value(QStringLiteral("room")).toString(), QStringLiteral("IDENTIFICATION_FAILED"),
               message);
  });
  connect(&library_, &LibraryService::cancelled, this, [this](const QString &op) {
    if (!identifying_.contains(op))
      return;
    const auto work = identifying_.take(op);
    const auto transfer = work.value(QStringLiteral("transfer")).toString();
    if (!transfer.isEmpty()) {
      hashing_.remove(indexKey(transfer, work.value(QStringLiteral("index")).toInt()));
      transfers_.releaseHold(transfer, op);
    }
    emit error(work.value(QStringLiteral("room")).toString(), QStringLiteral("CANCELLED"),
               QStringLiteral("Identification cancelled."));
  });
  connect(&rooms_, &RoomClient::operationComplete, this, [this](const QString &room, const QString &op) {
    try {
      for (auto value : store_.all(QStringLiteral("publish-direct"))) {
        const auto row = value.toObject();
        if (row.value(QStringLiteral("operation")).toString() == op)
          store_.remove(QStringLiteral("publish-direct"), row.value(QStringLiteral("id")).toString());
      }
    } catch (const AppError &e) {
      emit error(room, e.code(), e.message());
    }
    if (publishing_.contains(op)) {
      try {
        finishPublication(op, true);
        reconcile(room);
      } catch (const AppError &e) {
        emit error(room, e.code(), e.message());
      }
    }
    if (fingerprintOperations_.contains(op)) {
      fingerprintRooms_.remove(fingerprintOperations_.take(op));
      QTimer::singleShot(0, this, [this, room] { publishFingerprints(room); });
    }
  });
  connect(&rooms_, &RoomClient::error, this,
          [this](const QString &room, const QString &, const QString &, const QString &op) {
            try {
              const auto state =
                  store_.get(QStringLiteral("room-command"), op).value(QStringLiteral("state")).toString();
              if (state == QStringLiteral("pending"))
                return;
              if (publishing_.contains(op))
                finishPublication(op, false);
              if (fingerprintOperations_.contains(op))
                fingerprintRooms_.remove(fingerprintOperations_.take(op));
              if (!room.isEmpty())
                emit changed(room);
            } catch (const AppError &e) {
              emit error(room, e.code(), e.message());
            }
          });
  connect(&direct_, &DirectDownloads::ready, this, [this](const QString &, const QJsonObject &) {
    resumeDirectPublications();
    for (auto value : rooms_.rooms())
      reconcile(value.toObject().value(QStringLiteral("key")).toString());
  });
  connect(&direct_, &DirectDownloads::removed, this, [this](const QString &id) {
    removedAcquisition(QStringLiteral("download"), id);
    for (auto value : store_.find(QStringLiteral("publish-direct"), QStringLiteral("download"), id))
      store_.remove(QStringLiteral("publish-direct"),
                    value.toObject().value(QStringLiteral("id")).toString());
  });
  for (auto value : store_.all(QStringLiteral("torrent-file"))) {
    const auto row = value.toObject();
    identifiedFiles_.insert(indexKey(row.value(QStringLiteral("transfer")).toString(),
                                     row.value(QStringLiteral("index")).toInt()),
                            row.value(QStringLiteral("file")).toObject());
  }
  for (auto value : store_.all(QStringLiteral("publication"))) {
    const auto row = value.toObject();
    publishing_.insert(row.value(QStringLiteral("id")).toString(), row);
  }
  QTimer::singleShot(0, this, &RoomMedia::resumePublications);
  auto *identificationTimer = new QTimer(this);
  connect(identificationTimer, &QTimer::timeout, this, &RoomMedia::pumpIdentification);
  identificationTimer->start(200);
  libraryChanged();
}
RoomMedia::~RoomMedia() {
  for (auto it = preparingIdentification_.cbegin(); it != preparingIdentification_.cend(); ++it)
    transfers_.releaseHold(it.key().left(it.key().lastIndexOf(QLatin1Char(':'))), it.value());
  for (auto it = identifying_.begin(); it != identifying_.end(); ++it)
    if (!it.value().value(QStringLiteral("transfer")).toString().isEmpty())
      transfers_.releaseHold(it.value().value(QStringLiteral("transfer")).toString(), it.key());
  for (const auto &op : resolving_.keys())
    resolver_.cancel(op);
}
QString RoomMedia::bindingKey(const QString &room, const QString &source) const {
  return room + QLatin1Char(':') + source;
}
QString RoomMedia::mediaId(const QString &identity, int index) {
  return QStringLiteral("media:") +
         QString::fromLatin1(QCryptographicHash::hash(identity.toUtf8() + '\0' + QByteArray::number(index),
                                                      QCryptographicHash::Sha256)
                                 .toHex());
}
QString RoomMedia::prepare(const QString &input, const QString &room, const QString &root) {
  const auto op = resolver_.resolve(input);
  resolving_.insert(
      op,
      {{QStringLiteral("operation"), op}, {QStringLiteral("room"), room}, {QStringLiteral("root"), root}});
  return op;
}
void RoomMedia::resolved(const ResolvedSource &source) {
  if (!resolving_.contains(source.operationId))
    return;
  auto work = resolving_.take(source.operationId);
  const auto room = work.value(QStringLiteral("room")).toString(),
             key = work.value(QStringLiteral("binding")).toString();
  if (!key.isEmpty()) {
    bool present = false;
    for (auto v : rooms_.room(room).value(QStringLiteral("sources")).toArray())
      if (v.toObject().value(QStringLiteral("id")) == work.value(QStringLiteral("source")))
        present = true;
    if (!present) {
      sourceRequests_.remove(key);
      return;
    }
  }
  try {
    if (source.kind == QStringLiteral("torrent")) {
      const auto id = transfers_.add(source.localPath.isEmpty() ? source.uri : source.localPath,
                                     work.value(QStringLiteral("root")).toString());
      work.insert(QStringLiteral("kind"), source.kind);
      work.insert(QStringLiteral("transfer"), id);
      if (key.isEmpty())
        emit prepared(work);
      else {
        store_.put(QStringLiteral("room-source"), key,
                   {{QStringLiteral("room"), room},
                    {QStringLiteral("source"), work.value(QStringLiteral("source"))},
                    {QStringLiteral("kind"), source.kind},
                    {QStringLiteral("transfer"), id}});
        sourceRequests_.remove(key);
        reconcile(room);
      }
    } else if (source.kind == QStringLiteral("local")) {
      const auto op = library_.identify(source.localPath);
      work.insert(QStringLiteral("path"), source.localPath);
      identifying_.insert(op, work);
    } else if (source.kind == QStringLiteral("direct")) {
      const auto id = direct_.add(QUrl(source.uri), source.label);
      work.insert(QStringLiteral("kind"), source.kind);
      work.insert(QStringLiteral("download"), id);
      emit prepared(work);
    } else {
      work.insert(QStringLiteral("kind"), source.kind);
      work.insert(QStringLiteral("path"), source.localPath);
      emit prepared(work);
    }
  } catch (const AppError &e) {
    emit error(room, e.code(), e.message());
  }
  sourceRequests_.remove(key);
}
QString RoomMedia::publishTorrent(const QString &transfer, const QString &room, const QList<int> &selected,
                                  bool downloadHere, bool followRoom, qint64 expectedQueueRevision) {
  auto *native = transfers_.source(transfer);
  if (!native || native->files().isEmpty())
    throw AppError(QStringLiteral("METADATA_WAIT"),
                   QStringLiteral("Wait for the torrent's file list before applying this choice."));
  const auto identity = transfers_.view(transfer).identity;
  const auto sourceId = identity;
  QJsonArray files;
  QSet<int> choices(selected.begin(), selected.end());
  QStringList approved;
  QSet<int> known;
  for (const auto &f : native->files())
    known.insert(f.index);
  for (int index : choices)
    if (!known.contains(index))
      throw AppError(
          QStringLiteral("FILE_SELECTION"),
          QStringLiteral("A selected file is outside this torrent manifest. Refresh the content view."));
  for (const auto &f : native->files())
    if (TransferEngine::video(f.path) && f.size > 0) {
      const auto id = mediaId(identity, f.index);
      if (choices.contains(f.index))
        approved.append(id);
      if (manifestPath(f.path).size() > 2048)
        throw AppError(QStringLiteral("MANIFEST_PATH"),
                       QStringLiteral("A media path exceeds the 2,048-character room manifest limit."));
      files.append(QJsonObject{{QStringLiteral("mediaId"), id},
                               {QStringLiteral("path"), manifestPath(f.path)},
                               {QStringLiteral("label"), label(QFileInfo(f.path).completeBaseName())},
                               {QStringLiteral("fileIndex"), f.index},
                               {QStringLiteral("size"), f.size},
                               {QStringLiteral("duration"), QJsonValue::Null},
                               {QStringLiteral("selected"), choices.contains(f.index)}});
    }
  bool existingSource = false;
  for (auto value : rooms_.room(room).value(QStringLiteral("sources")).toArray())
    if (value.toObject().value(QStringLiteral("id")).toString() == sourceId)
      existingSource = true;
  if (files.isEmpty() || (approved.isEmpty() && !existingSource))
    throw AppError(QStringLiteral("NO_VIDEOS"),
                   QStringLiteral("Choose at least one video for the shared episode queue."));
  const QJsonObject source{{QStringLiteral("id"), sourceId},
                           {QStringLiteral("kind"), QStringLiteral("torrent")},
                           {QStringLiteral("label"), transfers_.view(transfer).name.left(300)},
                           {QStringLiteral("uri"), transfers_.magnet(transfer)},
                           {QStringLiteral("identity"), identity}};
  QJsonObject extras;
  if (downloadHere)
    for (const auto &f : native->files())
      if (!TransferEngine::video(f.path) && choices.contains(f.index))
        extras.insert(QString::number(f.index), 4);
  QJsonArray approvedIds, indexes;
  for (const auto &id : approved)
    approvedIds.append(id);
  for (const auto &f : native->files())
    if (TransferEngine::video(f.path) && choices.contains(f.index))
      indexes.append(f.index);
  const auto key = bindingKey(room, sourceId);
  QJsonObject work{{QStringLiteral("room"), room},
                   {QStringLiteral("source"), sourceId},
                   {QStringLiteral("binding"), key},
                   {QStringLiteral("transfer"), transfer},
                   {QStringLiteral("follow"), followRoom && downloadHere},
                   {QStringLiteral("download"), downloadHere},
                   {QStringLiteral("extras"), extras},
                   {QStringLiteral("approved"), approvedIds},
                   {QStringLiteral("files"), indexes},
                   {QStringLiteral("state"), QStringLiteral("pending")},
                   {QStringLiteral("decisionRevision"), store_.get(QStringLiteral("source-policy"), key)
                                                            .value(QStringLiteral("decisionRevision"))
                                                            .toInteger()},
                   {QStringLiteral("choiceRevision"),
                    transfers_.intent(transfer).value(QStringLiteral("choiceRevision")).toInteger()}};
  const auto op = rooms_.command(
      room,
      {{QStringLiteral("type"), QStringLiteral("queue.add")},
       {QStringLiteral("source"), source},
       {QStringLiteral("files"), files}},
      [&](const QString &id) {
        auto decision = store_.get(QStringLiteral("source-policy"), key);
        const auto revision = decision.value(QStringLiteral("decisionRevision")).toInteger() + 1;
        decision.insert(QStringLiteral("id"), key);
        decision.insert(QStringLiteral("room"), room);
        decision.insert(QStringLiteral("source"), sourceId);
        decision.insert(QStringLiteral("decisionRevision"), revision);
        store_.put(QStringLiteral("source-policy"), key, decision);
        work.insert(QStringLiteral("decisionRevision"), revision);
        work.insert(QStringLiteral("id"), id);
        store_.put(QStringLiteral("publication"), id, work);
        store_.put(QStringLiteral("room-source"), key,
                   {{QStringLiteral("room"), room},
                    {QStringLiteral("source"), sourceId},
                    {QStringLiteral("kind"), QStringLiteral("torrent")},
                    {QStringLiteral("transfer"), transfer}});
      },
      expectedQueueRevision >= 0 ? QJsonObject{{QStringLiteral("queueRevision"), expectedQueueRevision}}
                                 : QJsonObject());
  publishing_.insert(op, work);
  transfers_.reloadIntent(transfer);
  return op;
}
QString RoomMedia::publishDirect(const QString &download, const QString &room) {
  const auto local = direct_.download(download), file = local.value(QStringLiteral("file")).toObject();
  if (!LibraryService::unchanged(file))
    throw AppError(
        QStringLiteral("DIRECT_WAIT"),
        QStringLiteral("Finish and verify this direct download before publishing it to the room."));
  const auto sha = file.value(QStringLiteral("sha256")).toString(),
             identity = QStringLiteral("sha256:") + sha, sourceId = QStringLiteral("direct:") + sha;
  const QJsonObject source{
      {QStringLiteral("id"), sourceId},
      {QStringLiteral("kind"), QStringLiteral("direct")},
      {QStringLiteral("label"), local.value(QStringLiteral("label")).toString().left(300)},
      {QStringLiteral("uri"), local.value(QStringLiteral("url"))},
      {QStringLiteral("identity"), identity}};
  const QJsonObject descriptor{
      {QStringLiteral("mediaId"), mediaId(identity, 0)},
      {QStringLiteral("path"), fileName(local.value(QStringLiteral("label")).toString())},
      {QStringLiteral("label"),
       QFileInfo(local.value(QStringLiteral("label")).toString()).completeBaseName().left(300)},
      {QStringLiteral("fileIndex"), 0},
      {QStringLiteral("size"), file.value(QStringLiteral("size"))},
      {QStringLiteral("duration"), QJsonValue::Null},
      {QStringLiteral("selected"), true},
      {QStringLiteral("sha256"), sha}};
  return rooms_.command(room,
                        {{QStringLiteral("type"), QStringLiteral("queue.add")},
                         {QStringLiteral("source"), source},
                         {QStringLiteral("files"), QJsonArray{descriptor}}},
                        [&](const QString &op) {
                          store_.put(QStringLiteral("room-source"), bindingKey(room, sourceId),
                                     {{QStringLiteral("room"), room},
                                      {QStringLiteral("source"), sourceId},
                                      {QStringLiteral("kind"), QStringLiteral("direct")},
                                      {QStringLiteral("download"), download}});
                          const auto key = bindingKey(room, download);
                          auto row = store_.get(QStringLiteral("publish-direct"), key);
                          if (!row.isEmpty()) {
                            row.insert(QStringLiteral("operation"), op);
                            store_.put(QStringLiteral("publish-direct"), key, row);
                          }
                        });
}
void RoomMedia::requestDirectPublication(const QString &download, const QString &room) {
  rooms_.credential(room);
  if (direct_.download(download).isEmpty())
    throw AppError(QStringLiteral("DIRECT_MISSING"),
                   QStringLiteral("This direct download no longer exists."));
  const auto key = bindingKey(room, download);
  store_.put(
      QStringLiteral("publish-direct"), key,
      {{QStringLiteral("id"), key}, {QStringLiteral("room"), room}, {QStringLiteral("download"), download}});
  resumeDirectPublications();
}
void RoomMedia::resumeDirectPublications() {
  try {
    for (auto value : store_.all(QStringLiteral("publish-direct"))) {
      const auto row = value.toObject();
      const auto room = row.value(QStringLiteral("room")).toString(),
                 id = row.value(QStringLiteral("id")).toString(),
                 download = row.value(QStringLiteral("download")).toString();
      if (store_.get(QStringLiteral("room-private"), room).isEmpty()) {
        store_.remove(QStringLiteral("publish-direct"), id);
        continue;
      }
      const auto op = row.value(QStringLiteral("operation")).toString();
      if (!op.isEmpty()) {
        if (store_.get(QStringLiteral("room-command"), op).isEmpty())
          store_.remove(QStringLiteral("publish-direct"), id);
        continue;
      }
      if (rooms_.connected(room) &&
          direct_.download(download).value(QStringLiteral("state")).toString() == QStringLiteral("Ready")) {
        try {
          publishDirect(download, room);
        } catch (const AppError &e) {
          emit error(room, e.code(), e.message());
        }
      }
    }
  } catch (const AppError &e) {
    emit error({}, e.code(), e.message());
  }
}
QString RoomMedia::policy(const QString &room) const {
  return store_.get(QStringLiteral("room-policy"), room)
      .value(QStringLiteral("policy"))
      .toString(store_.setting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Ask")).toString());
}
QString RoomMedia::selectSource(const QString &room, const QString &source, const QStringList &ids,
                                bool downloadHere, qint64 revision) {
  const auto key = bindingKey(room, source);
  const auto local = store_.get(QStringLiteral("room-source"), key);
  const auto transfer = local.value(QStringLiteral("transfer")).toString();
  const auto native = transfer.isEmpty() ? QJsonObject() : transfers_.intent(transfer);
  QJsonArray selected, indexes;
  QSet<QString> known;
  const QSet<QString> wanted(ids.begin(), ids.end());
  for (auto value : rooms_.room(room).value(QStringLiteral("entries")).toArray()) {
    const auto e = value.toObject();
    if (e.value(QStringLiteral("sourceId")).toString() != source)
      continue;
    known.insert(e.value(QStringLiteral("mediaId")).toString());
    if (wanted.contains(e.value(QStringLiteral("mediaId")).toString()))
      indexes.append(e.value(QStringLiteral("fileIndex")));
  }
  for (const auto &id : ids) {
    if (!known.contains(id))
      throw AppError(QStringLiteral("FILE_SELECTION"),
                     QStringLiteral("A selected file is outside this source's manifest."));
    selected.append(id);
  }
  QJsonObject work{
      {QStringLiteral("room"), room},
      {QStringLiteral("source"), source},
      {QStringLiteral("binding"), key},
      {QStringLiteral("transfer"), transfer},
      {QStringLiteral("download"), downloadHere},
      {QStringLiteral("follow"), false},
      {QStringLiteral("extras"), QJsonObject()},
      {QStringLiteral("approved"), selected},
      {QStringLiteral("files"), indexes},
      {QStringLiteral("state"), QStringLiteral("pending")},
      {QStringLiteral("choiceRevision"), native.value(QStringLiteral("choiceRevision")).toInteger()}};
  const auto operation =
      rooms_.command(room,
                     {{QStringLiteral("type"), QStringLiteral("queue.select")},
                      {QStringLiteral("sourceId"), source},
                      {QStringLiteral("mediaIds"), selected}},
                     [&](const QString &op) {
                       auto decision = store_.get(QStringLiteral("source-policy"), key);
                       const auto next = decision.value(QStringLiteral("decisionRevision")).toInteger() + 1;
                       decision.insert(QStringLiteral("room"), room);
                       decision.insert(QStringLiteral("source"), source);
                       decision.insert(QStringLiteral("decisionRevision"), next);
                       store_.put(QStringLiteral("source-policy"), key, decision);
                       if (downloadHere) {
                         auto localIntent = store_.get(QStringLiteral("room-source"), key);
                         if (localIntent.value(QStringLiteral("removed")).toBool()) {
                           localIntent.remove(QStringLiteral("removed"));
                           store_.put(QStringLiteral("room-source"), key, localIntent);
                         }
                       }
                       work.insert(QStringLiteral("id"), op);
                       work.insert(QStringLiteral("decisionRevision"), next);
                       store_.put(QStringLiteral("publication"), op, work);
                     },
                     {{QStringLiteral("queueRevision"), revision}});
  publishing_.insert(operation, work);
  return operation;
}
void RoomMedia::setPolicy(const QString &room, const QString &value) {
  if (!QStringList{QStringLiteral("Auto"), QStringLiteral("Ask"), QStringLiteral("Never")}.contains(value))
    throw AppError(QStringLiteral("POLICY"), QStringLiteral("Choose Auto, Ask, or Never."));
  store_.put(QStringLiteral("room-policy"), room, {{QStringLiteral("policy"), value}});
  reconcile(room);
}
void RoomMedia::approve(const QString &room, const QString &source, const QStringList &ids) {
  const auto key = bindingKey(room, source);
  auto row = store_.get(QStringLiteral("source-policy"), key);
  QSet<QString> approved;
  for (auto id : row.value(QStringLiteral("approved")).toArray())
    approved.insert(id.toString());
  for (const auto &id : ids)
    approved.insert(id);
  QJsonArray array;
  for (const auto &id : approved)
    array.append(id);
  row.insert(QStringLiteral("id"), key);
  row.insert(QStringLiteral("room"), room);
  row.insert(QStringLiteral("source"), source);
  row.insert(QStringLiteral("approved"), array);
  row.insert(QStringLiteral("override"), QStringLiteral("Ask"));
  row.insert(QStringLiteral("decisionRevision"),
             row.value(QStringLiteral("decisionRevision")).toInteger() + 1);
  store_.transaction([&] {
    store_.put(QStringLiteral("source-policy"), key, row);
    auto local = store_.get(QStringLiteral("room-source"), key);
    if (local.value(QStringLiteral("removed")).toBool()) {
      local.remove(QStringLiteral("removed"));
      store_.put(QStringLiteral("room-source"), key, local);
    }
  });
  reconcile(room);
}
void RoomMedia::refuse(const QString &room, const QString &source) {
  const auto key = bindingKey(room, source);
  const auto revision =
      store_.get(QStringLiteral("source-policy"), key).value(QStringLiteral("decisionRevision")).toInteger();
  store_.put(QStringLiteral("source-policy"), key,
             {{QStringLiteral("id"), key},
              {QStringLiteral("room"), room},
              {QStringLiteral("source"), source},
              {QStringLiteral("override"), QStringLiteral("Never")},
              {QStringLiteral("approved"), QJsonArray()},
              {QStringLiteral("decisionRevision"), revision + 1}});
  reconcile(room);
}
QJsonObject RoomMedia::acquisition(const QString &room, const QString &source) const {
  auto row = store_.get(QStringLiteral("source-policy"), bindingKey(room, source));
  row.insert(QStringLiteral("effectivePolicy"), row.value(QStringLiteral("override")).toString(policy(room)));
  return row;
}
bool RoomMedia::localCopyAvailable(const QJsonObject &entry) const {
  const auto existing = bySha_.value(entry.value(QStringLiteral("sha256")).toString());
  return existing.value(QStringLiteral("size")) == entry.value(QStringLiteral("size")) &&
         LibraryService::unchanged(existing);
}
void RoomMedia::ensureSource(const QString &room, const QJsonObject &source) {
  const auto sourceId = source.value(QStringLiteral("id")).toString(), key = bindingKey(room, sourceId);
  const auto kind = source.value(QStringLiteral("kind")).toString();
  if (kind != QStringLiteral("torrent"))
    return;
  const auto previous = store_.get(QStringLiteral("room-source"), key);
  const auto id = previous.value(QStringLiteral("transfer")).toString();
  if (previous.value(QStringLiteral("removed")).toBool() || transfers_.source(id) ||
      sourceRequests_.contains(key))
    return;
  const auto op = resolver_.resolve(source.value(QStringLiteral("uri")).toString(), true);
  sourceRequests_.insert(key);
  resolving_.insert(op, {{QStringLiteral("operation"), op},
                         {QStringLiteral("room"), room},
                         {QStringLiteral("source"), sourceId},
                         {QStringLiteral("binding"), key}});
}
bool RoomMedia::validTorrentFile(const QString &transfer, const QJsonObject &source,
                                 const QJsonObject &entry) const {
  const auto identity = source.value(QStringLiteral("identity")).toString(),
             cacheKey = transfer + QLatin1Char('|') + identity;
  if (!identityCache_.contains(cacheKey))
    identityCache_.insert(cacheKey, transfers_.matchesIdentity(transfer, identity));
  if (!identityCache_.value(cacheKey))
    return false;
  const auto index = entry.value(QStringLiteral("fileIndex")).toInt(-1);
  const auto files = manifests_.value(transfer);
  auto it = files.find(index);
  if (it == files.end())
    return false;
  return manifestPath(it->path) == entry.value(QStringLiteral("path")).toString() &&
         it->size == entry.value(QStringLiteral("size")).toInteger() &&
         entry.value(QStringLiteral("mediaId")).toString() ==
             mediaId(source.value(QStringLiteral("identity")).toString(), index);
}
void RoomMedia::reconcile(const QString &room) {
  if (room.isEmpty() || reconciling_ || !rooms_.connected(room))
    return;
  reconciling_ = true;
  try {
    resumePublications();
    const auto snapshot = rooms_.room(room);
    QHash<QString, QList<QJsonObject>> entries;
    QSet<QString> validSources;
    for (auto value : snapshot.value(QStringLiteral("sources")).toArray())
      validSources.insert(value.toObject().value(QStringLiteral("id")).toString());
    for (auto value : store_.find(QStringLiteral("room-source"), QStringLiteral("room"), room)) {
      const auto local = value.toObject();
      const auto source = local.value(QStringLiteral("source")).toString();
      if (validSources.contains(source))
        continue;
      const auto key = bindingKey(room, source);
      transfers_.removeDemand(key);
      direct_.removeDemand(key);
      store_.remove(QStringLiteral("room-source"), key);
    }
    for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
      const auto e = value.toObject();
      entries[e.value(QStringLiteral("sourceId")).toString()].append(e);
    }
    for (auto value : snapshot.value(QStringLiteral("sources")).toArray()) {
      const auto source = value.toObject();
      const auto sourceId = source.value(QStringLiteral("id")).toString(), key = bindingKey(room, sourceId);
      ensureSource(room, source);
      const auto local = store_.get(QStringLiteral("room-source"), key),
                 acquisitionState = acquisition(room, sourceId);
      const auto transfer = local.value(QStringLiteral("transfer")).toString(),
                 effective = acquisitionState.value(QStringLiteral("effectivePolicy")).toString();
      QSet<QString> approved;
      for (auto id : acquisitionState.value(QStringLiteral("approved")).toArray())
        approved.insert(id.toString());
      QList<int> selected;
      if (source.value(QStringLiteral("kind")).toString() == QStringLiteral("torrent") &&
          transfers_.source(transfer)) {
        if (!manifests_.contains(transfer)) {
          QHash<int, TorrentFile> files;
          for (const auto &f : transfers_.source(transfer)->files())
            files.insert(f.index, f);
          manifests_.insert(transfer, files);
        }
        for (const auto &entry : entries.value(sourceId))
          if (entry.value(QStringLiteral("enabled")).toBool() && validTorrentFile(transfer, source, entry)) {
            const auto existing = bySha_.value(entry.value(QStringLiteral("sha256")).toString());
            const bool reused = LibraryService::unchanged(existing) &&
                                existing.value(QStringLiteral("managedTransfer")).toString() != transfer;
            if (!reused && (effective == QStringLiteral("Auto") ||
                            (effective == QStringLiteral("Ask") &&
                             approved.contains(entry.value(QStringLiteral("mediaId")).toString()))))
              selected.append(entry.value(QStringLiteral("fileIndex")).toInt());
          }
        transfers_.setDemand(key, transfer, selected, effective, true);
        const auto progress = transfers_.fileProgress(transfer);
        for (const auto &entry : entries.value(sourceId)) {
          const int index = entry.value(QStringLiteral("fileIndex")).toInt(-1);
          if (entry.value(QStringLiteral("sha256")).toString().isEmpty() &&
              entry.value(QStringLiteral("enabled")).toBool() &&
              !hashing_.contains(indexKey(transfer, index)) && validTorrentFile(transfer, source, entry) &&
              index >= 0 && index < progress.size() &&
              progress[index] >= entry.value(QStringLiteral("size")).toInteger() &&
              !LibraryService::unchanged(identifiedFiles_.value(indexKey(transfer, index))))
            queueIdentification(transfer, index);
        }
      } else if (source.value(QStringLiteral("kind")).toString() == QStringLiteral("direct")) {
        bool wanted = false;
        QString download = local.value(QStringLiteral("download")).toString();
        for (const auto &entry : entries.value(sourceId))
          if (entry.value(QStringLiteral("enabled")).toBool() &&
              !LibraryService::unchanged(bySha_.value(entry.value(QStringLiteral("sha256")).toString())) &&
              (effective == QStringLiteral("Auto") ||
               (effective == QStringLiteral("Ask") &&
                approved.contains(entry.value(QStringLiteral("mediaId")).toString())))) {
            const auto sha = entry.value(QStringLiteral("sha256")).toString();
            if (sha.size() != 64 ||
                source.value(QStringLiteral("identity")).toString() != QStringLiteral("sha256:") + sha ||
                entry.value(QStringLiteral("mediaId")).toString() !=
                    mediaId(source.value(QStringLiteral("identity")).toString(), 0) ||
                entry.value(QStringLiteral("fileIndex")).toInt(-1) != 0) {
              emit error(room, QStringLiteral("MANIFEST_MISMATCH"),
                         QStringLiteral("This direct source has no valid shared content fingerprint."));
              continue;
            }
            download = direct_.add(QUrl(source.value(QStringLiteral("uri")).toString()),
                                   entry.value(QStringLiteral("label")).toString(), sha,
                                   entry.value(QStringLiteral("size")).toInteger(), true);
            wanted = true;
            store_.put(QStringLiteral("room-source"), key,
                       {{QStringLiteral("room"), room},
                        {QStringLiteral("source"), sourceId},
                        {QStringLiteral("kind"), QStringLiteral("direct")},
                        {QStringLiteral("download"), download}});
          }
        if (!download.isEmpty())
          direct_.setDemand(key, download, wanted);
      }
    }
  } catch (const AppError &e) {
    emit error(room, e.code(), e.message());
  }
  reconciling_ = false;
  publishFingerprints(room);
  emit changed(room);
}
void RoomMedia::libraryChanged() {
  bySha_.clear();
  for (auto value : library_.files()) {
    const auto f = value.toObject();
    if (!f.value(QStringLiteral("missing")).toBool()) {
      const auto sha = f.value(QStringLiteral("sha256")).toString();
      if (!bySha_.contains(sha) || !LibraryService::unchanged(bySha_.value(sha)))
        bySha_.insert(sha, f);
    }
  }
  for (auto value : rooms_.rooms())
    reconcile(value.toObject().value(QStringLiteral("key")).toString());
}
LocalFileSource *RoomMedia::localSource(const QJsonObject &file) {
  const auto id = file.value(QStringLiteral("id")).toString() + QLatin1Char(':') +
                  file.value(QStringLiteral("sha256")).toString();
  auto it = localSources_.find(id);
  if (it == localSources_.end())
    localSources_[id] = std::make_unique<LocalFileSource>(file);
  return localSources_.at(id).get();
}
MediaBinding RoomMedia::binding(const QString &room, const QString &entryId) {
  const auto snapshot = rooms_.room(room);
  const auto entry = rooms_.entry(room, entryId);
  QJsonObject source;
  if (entry.isEmpty())
    return {{}, -1, {}, {}, {}, QStringLiteral("Choose an episode")};
  for (auto value : snapshot.value(QStringLiteral("sources")).toArray())
    if (value.toObject().value(QStringLiteral("id")) == entry.value(QStringLiteral("sourceId"))) {
      source = value.toObject();
      break;
    }
  if (entry.value(QStringLiteral("mediaId")).toString() !=
      mediaId(source.value(QStringLiteral("identity")).toString(),
              entry.value(QStringLiteral("fileIndex")).toInt(-1)))
    return {{}, -1, {},
            {}, {}, QStringLiteral("The shared media identity is inconsistent. Re-add this source.")};
  const auto existing = bySha_.value(entry.value(QStringLiteral("sha256")).toString());
  if (LibraryService::unchanged(existing) &&
      existing.value(QStringLiteral("size")) == entry.value(QStringLiteral("size")))
    return {localSource(existing),
            0,
            entry.value(QStringLiteral("mediaId")).toString(),
            existing.value(QStringLiteral("managedTransfer")).toString(),
            existing.value(QStringLiteral("path")).toString(),
            {},
            existing.value(QStringLiteral("managedIndex")).toInt(-1)};
  const auto kind = source.value(QStringLiteral("kind")).toString();
  if (kind == QStringLiteral("share") && sharedBinding_)
    return sharedBinding_(room, source, entry);
  const auto local = store_.get(QStringLiteral("room-source"),
                                bindingKey(room, source.value(QStringLiteral("id")).toString()));
  if (kind == QStringLiteral("torrent")) {
    const auto id = local.value(QStringLiteral("transfer")).toString();
    auto *native = transfers_.source(id);
    if (!native || native->files().isEmpty())
      return {{}, -1, {}, id, {}, QStringLiteral("Retrieving torrent metadata…")};
    if (!validTorrentFile(id, source, entry))
      return {{},
              -1,
              {},
              id,
              {},
              QStringLiteral("The synchronized episode does not match this torrent's verified manifest. "
                             "Re-add the source or locate the exact file.")};
    const int index = entry.value(QStringLiteral("fileIndex")).toInt();
    if (!native->selected(index))
      return {{},
              -1,
              {},
              id,
              {},
              QStringLiteral("This episode is not selected for this device. Approve its download or locate a "
                             "matching local copy.")};
    // Pausing acquisition does not make already verified bytes unavailable.
    // The reader never requests missing pieces while paused; playback can use
    // its existing data until an actual underrun invokes the room barrier.
    return {native, index, entry.value(QStringLiteral("mediaId")).toString(),
            id,     {},    native->paused() ? transfers_.view(id).reason : QString(),
            index};
  }
  if (kind == QStringLiteral("direct"))
    return {
        {}, -1,
        {}, {},
        {}, QStringLiteral("Download and verify this URL on this device, or locate a matching local copy.")};
  return {{}, -1, {}, {}, {}, QStringLiteral("Waiting for the publisher's local sharing service…")};
}
void RoomMedia::queueIdentification(const QString &transfer, int index) {
  const auto files = manifests_.value(transfer);
  if (files.contains(index) && !TransferEngine::video(files.value(index).path))
    return;
  const auto key = indexKey(transfer, index);
  if (hashing_.contains(key) || preparingIdentification_.contains(key) ||
      queuedIdentification_.contains(key) || LibraryService::unchanged(identifiedFiles_.value(key)))
    return;
  queuedIdentification_.insert(key);
  identificationQueue_.enqueue({transfer, index});
}
void RoomMedia::pumpIdentification() {
  // Waiting jobs hold no transfer or old disk path. Only the two jobs actually
  // flushing/hashing block a move, even when a complete pack has 10,000 files.
  while (!identificationQueue_.isEmpty() && hashing_.size() + preparingIdentification_.size() < 2) {
    const auto work = identificationQueue_.dequeue();
    const auto key = indexKey(work.first, work.second);
    queuedIdentification_.remove(key);
    if (!transfers_.source(work.first) || LibraryService::unchanged(identifiedFiles_.value(key)))
      continue;
    const auto token = QStringLiteral("identification:") + key;
    try {
      transfers_.hold(work.first, token);
      preparingIdentification_.insert(key, token);
      if (!transfers_.requestIdentifiedCopy(work.first, work.second)) {
        preparingIdentification_.remove(key);
        transfers_.releaseHold(work.first, token);
      }
    } catch (const AppError &e) {
      preparingIdentification_.remove(key);
      transfers_.releaseHold(work.first, token);
      emit error({}, e.code(), e.message());
    }
  }
}
void RoomMedia::identify(const QString &transfer, int index, const QString &path) {
  const auto key = indexKey(transfer, index);
  const auto token = preparingIdentification_.take(key);
  if (!token.isEmpty())
    transfers_.releaseHold(transfer, token);
  if (hashing_.contains(key) || !TransferEngine::video(path))
    return;
  const auto cached = identifiedFiles_.value(key);
  if (LibraryService::unchanged(cached)) {
    for (auto value : rooms_.rooms())
      publishFingerprints(value.toObject().value(QStringLiteral("key")).toString());
    return;
  }
  QString op;
  try {
    op = library_.identify(path);
  } catch (const AppError &e) {
    emit error({}, e.code(), e.message());
    return;
  }
  hashing_.insert(key);
  identifying_.insert(op, {{QStringLiteral("transfer"), transfer}, {QStringLiteral("index"), index}});
  transfers_.hold(transfer, op);
}
void RoomMedia::publishFingerprints(const QString &room) {
  if (!rooms_.connected(room) || fingerprintRooms_.contains(room))
    return;
  try {
    const auto snapshot = rooms_.room(room);
    QHash<QString, QJsonObject> sources;
    QHash<QString, QString> bindings;
    for (auto value : snapshot.value(QStringLiteral("sources")).toArray()) {
      const auto s = value.toObject();
      const auto id = s.value(QStringLiteral("id")).toString();
      sources.insert(id, s);
      bindings.insert(id, store_.get(QStringLiteral("room-source"), bindingKey(room, id))
                              .value(QStringLiteral("transfer"))
                              .toString());
    }
    for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
      const auto entry = value.toObject();
      if (!entry.value(QStringLiteral("sha256")).toString().isEmpty())
        continue;
      const auto source = sources.value(entry.value(QStringLiteral("sourceId")).toString());
      if (source.value(QStringLiteral("kind")).toString() != QStringLiteral("torrent"))
        continue;
      const auto transfer = bindings.value(source.value(QStringLiteral("id")).toString());
      if (!transfers_.source(transfer) || !validTorrentFile(transfer, source, entry))
        continue;
      const int index = entry.value(QStringLiteral("fileIndex")).toInt();
      const auto file = identifiedFiles_.value(indexKey(transfer, index));
      if (LibraryService::unchanged(file)) {
        const auto op =
            rooms_.command(room, {{QStringLiteral("type"), QStringLiteral("queue.identify")},
                                  {QStringLiteral("entryId"), entry.value(QStringLiteral("id"))},
                                  {QStringLiteral("sha256"), file.value(QStringLiteral("sha256"))}});
        fingerprintRooms_.insert(room);
        fingerprintOperations_.insert(op, room);
        return;
      }
    }
  } catch (const AppError &e) {
    emit error(room, e.code(), e.message());
  }
}
void RoomMedia::finishPublication(const QString &op, bool accepted) {
  auto work = store_.get(QStringLiteral("publication"), op);
  if (work.isEmpty()) {
    publishing_.remove(op);
    return;
  }
  const auto room = work.value(QStringLiteral("room")).toString(),
             transfer = work.value(QStringLiteral("transfer")).toString(),
             key = work.value(QStringLiteral("binding")).toString();
  if (store_.get(QStringLiteral("room-private"), room).isEmpty())
    accepted = false;
  if (accepted && work.value(QStringLiteral("state")).toString() != QStringLiteral("accepted")) {
    auto decision = store_.get(QStringLiteral("source-policy"), key),
         native = store_.get(QStringLiteral("transfer"), transfer);
    const auto local = store_.get(QStringLiteral("room-source"), key);
    const bool current = decision.value(QStringLiteral("decisionRevision")) ==
                             work.value(QStringLiteral("decisionRevision")) &&
                         !local.value(QStringLiteral("removed")).toBool();
    const bool download = work.value(QStringLiteral("download")).toBool();
    store_.transaction([&] {
      if (current) {
        QSet<QString> approved;
        for (auto value : decision.value(QStringLiteral("approved")).toArray())
          approved.insert(value.toString());
        if (download)
          for (auto value : work.value(QStringLiteral("approved")).toArray())
            approved.insert(value.toString());
        else
          approved.clear();
        QJsonArray choices;
        for (const auto &id : approved)
          choices.append(id);
        decision.insert(QStringLiteral("approved"), choices);
        decision.insert(QStringLiteral("override"),
                        download ? QStringLiteral("Ask") : QStringLiteral("Never"));
        store_.put(QStringLiteral("source-policy"), key, decision);
        store_.put(QStringLiteral("demand"), key,
                   {{QStringLiteral("id"), key},
                    {QStringLiteral("transfer"), transfer},
                    {QStringLiteral("files"),
                     download ? work.value(QStringLiteral("files")) : QJsonValue(QJsonArray())},
                    {QStringLiteral("policy"), download ? QStringLiteral("Ask") : QStringLiteral("Never")},
                    {QStringLiteral("approved"), download}});
        // A delayed shared acknowledgment must not erase a newer local file
        // refusal. Pause state is retained independently in the native intent.
        if (download && !native.isEmpty() &&
            native.value(QStringLiteral("choiceRevision")).toInteger() ==
                work.value(QStringLiteral("choiceRevision")).toInteger()) {
          auto overrides = work.value(QStringLiteral("follow")).toBool()
                               ? QJsonObject()
                               : native.value(QStringLiteral("overrides")).toObject();
          const auto extras = work.value(QStringLiteral("extras")).toObject();
          for (auto it = extras.begin(); it != extras.end(); ++it)
            overrides.insert(it.key(), it.value());
          if (work.value(QStringLiteral("follow")).toBool() || !extras.isEmpty()) {
            native.insert(QStringLiteral("overrides"), overrides);
            native.insert(QStringLiteral("choiceRevision"),
                          native.value(QStringLiteral("choiceRevision")).toInteger() + 1);
            store_.put(QStringLiteral("transfer"), transfer, native);
          }
        }
      }
      work.insert(QStringLiteral("state"), QStringLiteral("accepted"));
      store_.put(QStringLiteral("publication"), op, work);
    });
    publishing_.insert(op, work);
  }
  if (!accepted) {
    store_.remove(QStringLiteral("publication"), op);
    publishing_.remove(op);
    if (transfers_.source(transfer))
      transfers_.reloadIntent(transfer);
    return;
  }
  // The accepted journal survives a crash between SQLite commit and native
  // engine application. Reapplying committed intent is safe and idempotent.
  if (transfers_.source(transfer))
    transfers_.reloadIntent(transfer);
  store_.remove(QStringLiteral("publication"), op);
  publishing_.remove(op);
}
void RoomMedia::resumePublications() {
  resumeDirectPublications();
  for (const auto &op : publishing_.keys()) {
    try {
      const auto work = publishing_.value(op), command = store_.get(QStringLiteral("room-command"), op);
      const auto state = command.value(QStringLiteral("state")).toString();
      if (work.value(QStringLiteral("state")).toString() == QStringLiteral("accepted") || command.isEmpty())
        finishPublication(op, true);
      else if (state != QStringLiteral("pending"))
        finishPublication(op, false);
    } catch (const AppError &e) {
      emit error({}, e.code(), e.message());
    }
  }
}
void RoomMedia::forgetRoom(const QString &room) {
  for (const auto &op : identifying_.keys()) {
    const auto work = identifying_.value(op);
    if (work.value(QStringLiteral("transfer")).toString().isEmpty() &&
        work.value(QStringLiteral("room")).toString() == room)
      library_.cancel(op);
  }
  for (auto value : store_.find(QStringLiteral("publish-direct"), QStringLiteral("room"), room))
    store_.remove(QStringLiteral("publish-direct"), value.toObject().value(QStringLiteral("id")).toString());
  for (const auto &op : resolving_.keys())
    if (resolving_.value(op).value(QStringLiteral("room")).toString() == room) {
      sourceRequests_.remove(resolving_.value(op).value(QStringLiteral("binding")).toString());
      resolving_.remove(op);
      resolver_.cancel(op);
    }
  for (const auto &op : publishing_.keys())
    if (publishing_.value(op).value(QStringLiteral("room")).toString() == room) {
      store_.remove(QStringLiteral("publication"), op);
      publishing_.remove(op);
    }
  for (auto value : store_.find(QStringLiteral("room-source"), QStringLiteral("room"), room)) {
    const auto row = value.toObject();
    const auto key = bindingKey(room, row.value(QStringLiteral("source")).toString());
    transfers_.removeDemand(key);
    direct_.removeDemand(key);
    store_.remove(QStringLiteral("room-source"), key);
    store_.remove(QStringLiteral("source-policy"), key);
  }
  store_.remove(QStringLiteral("room-policy"), room);
}
void RoomMedia::removedAcquisition(const QString &field, const QString &id) {
  try {
    QSet<QString> affectedRooms, bindings;
    const auto references = store_.find(QStringLiteral("room-source"), field, id);
    // Refusals were committed atomically with removal intent by the engine.
    // Do not overwrite a later explicit approval when native removal finishes.
    for (auto value : references) {
      const auto row = value.toObject();
      const auto room = row.value(QStringLiteral("room")).toString(),
                 source = row.value(QStringLiteral("source")).toString(), key = bindingKey(room, source);
      affectedRooms.insert(room);
      bindings.insert(key);
    }
    for (const auto &op : resolving_.keys())
      if (bindings.contains(resolving_.value(op).value(QStringLiteral("binding")).toString())) {
        sourceRequests_.remove(resolving_.value(op).value(QStringLiteral("binding")).toString());
        resolving_.remove(op);
        resolver_.cancel(op);
      }
    for (const auto &room : affectedRooms)
      reconcile(room);
  } catch (const AppError &e) {
    emit error({}, e.code(), e.message());
  }
}
} // namespace wp
