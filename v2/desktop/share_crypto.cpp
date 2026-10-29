#include "share_crypto.h"
#include "local_store.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <algorithm>
#include <memory>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
namespace wp::sharing {
namespace {
[[noreturn]] void fail() {
  throw AppError(
      QStringLiteral("SHARE_INTEGRITY"),
      QStringLiteral("The encrypted transfer could not be authenticated. Reconnect both devices."));
}
QByteArray sha(const QByteArray &data) {
  return QCryptographicHash::hash(data, QCryptographicHash::Sha256);
}
QByteArray parent(const QByteArray &a, const QByteArray &b) {
  return sha(QByteArray(1, '\1') + a + b);
}
QByteArray mac(const QByteArray &key, const QByteArray &data) {
  QByteArray out(32, Qt::Uninitialized);
  unsigned int size = 0;
  if (!HMAC(EVP_sha256(), key.constData(), key.size(),
            reinterpret_cast<const unsigned char *>(data.constData()), data.size(),
            reinterpret_cast<unsigned char *>(out.data()), &size) ||
      size != 32)
    fail();
  return out;
}
} // namespace
QByteArray random(int length) {
  if (length < 1 || length > 1024)
    fail();
  QByteArray out(length, Qt::Uninitialized);
  if (RAND_bytes(reinterpret_cast<unsigned char *>(out.data()), length) != 1)
    fail();
  return out;
}
QByteArray publicKey(const QByteArray &privateKey) {
  if (privateKey.size() != 32)
    fail();
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
      EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, nullptr,
                                   reinterpret_cast<const unsigned char *>(privateKey.constData()), 32),
      EVP_PKEY_free);
  QByteArray out(32, Qt::Uninitialized);
  size_t size = 32;
  if (!key ||
      EVP_PKEY_get_raw_public_key(key.get(), reinterpret_cast<unsigned char *>(out.data()), &size) != 1 ||
      size != 32)
    fail();
  return out;
}
QByteArray deriveKey(const QByteArray &privateKey, const QByteArray &peerPublicKey,
                     const QByteArray &context) {
  if (privateKey.size() != 32 || peerPublicKey.size() != 32)
    fail();
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> own(
      EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, nullptr,
                                   reinterpret_cast<const unsigned char *>(privateKey.constData()), 32),
      EVP_PKEY_free),
      peer(EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, nullptr,
                                       reinterpret_cast<const unsigned char *>(peerPublicKey.constData()),
                                       32),
           EVP_PKEY_free);
  if (!own || !peer)
    fail();
  std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> ctx(EVP_PKEY_CTX_new(own.get(), nullptr),
                                                                  EVP_PKEY_CTX_free);
  QByteArray secret(32, Qt::Uninitialized);
  size_t size = 32;
  if (!ctx || EVP_PKEY_derive_init(ctx.get()) != 1 || EVP_PKEY_derive_set_peer(ctx.get(), peer.get()) != 1 ||
      EVP_PKEY_derive(ctx.get(), reinterpret_cast<unsigned char *>(secret.data()), &size) != 1 || size != 32)
    fail();
  // RFC 5869 HKDF-SHA256, a context-specific salt and one 32-byte block.
  const auto extracted = mac(sha(context), secret);
  OPENSSL_cleanse(secret.data(), secret.size());
  return mac(extracted, context + QByteArray(1, '\1'));
}
QByteArray seal(const QByteArray &key, const QByteArray &plaintext, const QByteArray &context) {
  if (key.size() != 32 || plaintext.size() > 2 * 1024 * 1024)
    fail();
  const auto nonce = random(12);
  QByteArray out(plaintext.size() + 16, Qt::Uninitialized);
  int length = 0, total = 0;
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(EVP_CIPHER_CTX_new(),
                                                                      EVP_CIPHER_CTX_free);
  if (!ctx ||
      EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr,
                         reinterpret_cast<const unsigned char *>(key.constData()),
                         reinterpret_cast<const unsigned char *>(nonce.constData())) != 1 ||
      EVP_EncryptUpdate(ctx.get(), nullptr, &length,
                        reinterpret_cast<const unsigned char *>(context.constData()), context.size()) != 1 ||
      EVP_EncryptUpdate(ctx.get(), reinterpret_cast<unsigned char *>(out.data()), &length,
                        reinterpret_cast<const unsigned char *>(plaintext.constData()),
                        plaintext.size()) != 1)
    fail();
  total = length;
  if (EVP_EncryptFinal_ex(ctx.get(), reinterpret_cast<unsigned char *>(out.data() + total), &length) != 1)
    fail();
  total += length;
  out.resize(total);
  QByteArray tag(16, Qt::Uninitialized);
  if (EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, 16, tag.data()) != 1)
    fail();
  return nonce + out + tag;
}
QByteArray open(const QByteArray &key, const QByteArray &ciphertext, const QByteArray &context) {
  if (key.size() != 32 || ciphertext.size() < 28 || ciphertext.size() > 2 * 1024 * 1024 + 28)
    fail();
  const auto nonce = ciphertext.first(12), tag = ciphertext.last(16),
             data = ciphertext.sliced(12, ciphertext.size() - 28);
  QByteArray out(data.size() + 16, Qt::Uninitialized);
  int length = 0, total = 0;
  std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)> ctx(EVP_CIPHER_CTX_new(),
                                                                      EVP_CIPHER_CTX_free);
  if (!ctx ||
      EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr,
                         reinterpret_cast<const unsigned char *>(key.constData()),
                         reinterpret_cast<const unsigned char *>(nonce.constData())) != 1 ||
      EVP_DecryptUpdate(ctx.get(), nullptr, &length,
                        reinterpret_cast<const unsigned char *>(context.constData()), context.size()) != 1 ||
      EVP_DecryptUpdate(ctx.get(), reinterpret_cast<unsigned char *>(out.data()), &length,
                        reinterpret_cast<const unsigned char *>(data.constData()), data.size()) != 1)
    fail();
  total = length;
  if (EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, 16, const_cast<char *>(tag.constData())) != 1 ||
      EVP_DecryptFinal_ex(ctx.get(), reinterpret_cast<unsigned char *>(out.data() + total), &length) != 1)
    fail();
  total += length;
  out.resize(total);
  return out;
}
QByteArray leaf(const QByteArray &bytes) {
  return sha(QByteArray(1, '\0') + bytes);
}
QByteArray root(const QList<QByteArray> &hashes) {
  if (hashes.isEmpty())
    return {};
  auto layer = hashes;
  while (layer.size() > 1) {
    QList<QByteArray> next;
    next.reserve((layer.size() + 1) / 2);
    for (int i = 0; i < layer.size(); i += 2)
      next.append(parent(layer[i], layer[std::min(i + 1, int(layer.size()) - 1)]));
    layer = std::move(next);
  }
  return layer.first();
}
MerkleTree tree(const QList<QByteArray> &hashes) {
  MerkleTree layers;
  if (hashes.isEmpty())
    return layers;
  layers.append(hashes);
  while (layers.last().size() > 1) {
    const auto &current = layers.last();
    QList<QByteArray> next;
    next.reserve((current.size() + 1) / 2);
    for (int i = 0; i < current.size(); i += 2)
      next.append(parent(current[i], current[std::min(i + 1, int(current.size()) - 1)]));
    layers.append(next);
  }
  return layers;
}
QJsonArray proof(const MerkleTree &layers, int index) {
  if (layers.isEmpty() || index < 0 || index >= layers.first().size())
    fail();
  QJsonArray out;
  for (int level = 0; level < layers.size() - 1; ++level) {
    const auto &layer = layers[level];
    out.append(QString::fromLatin1(layer[std::min(index ^ 1, int(layer.size()) - 1)].toHex()));
    index /= 2;
  }
  return out;
}
QJsonArray proof(const QList<QByteArray> &hashes, int index) {
  if (index < 0 || index >= hashes.size())
    fail();
  QJsonArray out;
  auto layer = hashes;
  while (layer.size() > 1) {
    out.append(QString::fromLatin1(layer[std::min(index ^ 1, int(layer.size()) - 1)].toHex()));
    QList<QByteArray> next;
    for (int i = 0; i < layer.size(); i += 2)
      next.append(parent(layer[i], layer[std::min(i + 1, int(layer.size()) - 1)]));
    layer = std::move(next);
    index /= 2;
  }
  return out;
}
bool verify(const QByteArray &bytes, int index, int count, const QJsonArray &path,
            const QByteArray &expected) {
  if (index < 0 || index >= count || count < 1 || expected.size() != 32 || path.size() > 32)
    return false;
  auto value = leaf(bytes);
  int level = 0;
  for (int width = count; width > 1; width = (width + 1) / 2) {
    if (level >= path.size())
      return false;
    const auto sibling = QByteArray::fromHex(path[level++].toString().toLatin1());
    if (sibling.size() != 32)
      return false;
    if ((index ^ 1) >= width && sibling != value)
      return false;
    value = index & 1 ? parent(sibling, value) : parent(value, sibling);
    index /= 2;
  }
  return level == path.size() && value == expected;
}
QJsonObject identify(const QString &path, const QString &relative, int index,
                     const std::shared_ptr<std::atomic_bool> &cancel) {
  const QFileInfo before(path);
  if (!before.isFile() || before.isSymLink() || before.size() < 1)
    throw AppError(QStringLiteral("SHARE_FILE"), QStringLiteral("Choose an accessible nonempty media file."));
  if (before.size() > qint64(1) << 40)
    throw AppError(
        QStringLiteral("SHARE_FILE"),
        QStringLiteral("A shared file can be at most 1 TiB. Split this source into smaller files."));
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly))
    throw AppError(QStringLiteral("SHARE_FILE"), QStringLiteral("The shared file could not be opened."));
  QCryptographicHash hash(QCryptographicHash::Sha256);
  QList<QByteArray> leaves;
  QJsonArray chunks;
  while (!file.atEnd()) {
    if (cancel->load())
      return {};
    const auto bytes = file.read(ChunkSize);
    if (bytes.isEmpty() && file.error() != QFile::NoError)
      throw AppError(QStringLiteral("SHARE_FILE"), QStringLiteral("Reading the shared file failed."));
    hash.addData(bytes);
    const auto digest = leaf(bytes);
    leaves.append(digest);
    chunks.append(QString::fromLatin1(digest.toHex()));
  }
  const QFileInfo after(path);
  if (before.size() != after.size() || before.lastModified() != after.lastModified() || !after.isFile() ||
      after.isSymLink())
    throw AppError(
        QStringLiteral("SHARE_CHANGED"),
        QStringLiteral("The source changed during preparation. Wait for its copy or download to complete."));
  return {{QStringLiteral("path"), after.canonicalFilePath()},
          {QStringLiteral("relative"), relative},
          {QStringLiteral("index"), index},
          {QStringLiteral("size"), after.size()},
          {QStringLiteral("mtime"), after.lastModified().toMSecsSinceEpoch()},
          {QStringLiteral("sha256"), QString::fromLatin1(hash.result().toHex())},
          {QStringLiteral("merkleRoot"), QString::fromLatin1(root(leaves).toHex())},
          {QStringLiteral("chunks"), chunks}};
}
QList<QByteArray> hashes(const QJsonObject &file) {
  QList<QByteArray> out;
  for (auto value : file.value(QStringLiteral("chunks")).toArray())
    out.append(QByteArray::fromHex(value.toString().toLatin1()));
  return out;
}
QByteArray context(const QString &room, const QString &a, const QString &b) {
  const auto order = a < b ? QStringList{a, b} : QStringList{b, a};
  return QByteArray("WatchPair/v2/share\0", 19) + room.toUtf8() + '\0' + order[0].toUtf8() + '\0' +
         order[1].toUtf8();
}
} // namespace wp::sharing
