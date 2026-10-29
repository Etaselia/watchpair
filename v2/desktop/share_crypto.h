#pragma once
#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <atomic>
#include <memory>
namespace wp::sharing {
constexpr int ChunkSize = 1024 * 1024;
QByteArray random(int length);
QByteArray publicKey(const QByteArray &privateKey);
QByteArray deriveKey(const QByteArray &privateKey, const QByteArray &peerPublicKey,
                     const QByteArray &context);
QByteArray seal(const QByteArray &key, const QByteArray &plaintext, const QByteArray &context);
QByteArray open(const QByteArray &key, const QByteArray &ciphertext, const QByteArray &context);
QByteArray leaf(const QByteArray &bytes);
using MerkleTree = QList<QList<QByteArray>>;
MerkleTree tree(const QList<QByteArray> &hashes);
QJsonArray proof(const MerkleTree &tree, int index);
QByteArray root(const QList<QByteArray> &hashes);
QJsonArray proof(const QList<QByteArray> &hashes, int index);
bool verify(const QByteArray &bytes, int index, int count, const QJsonArray &proof, const QByteArray &root);
QJsonObject identify(const QString &path, const QString &relative, int index,
                     const std::shared_ptr<std::atomic_bool> &cancel);
QList<QByteArray> hashes(const QJsonObject &file);
QByteArray context(const QString &room, const QString &a, const QString &b);
} // namespace wp::sharing
