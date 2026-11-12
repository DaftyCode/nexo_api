//! Reading records: the offsets to start from, fetching and decoding record batches.
use super::*;

impl Cluster {
    /// Where reading starts in each partition of a topic (or only the one given).
    pub async fn positions(
        &mut self,
        name: &str,
        partition: Option<i32>,
        start: Start,
    ) -> Result<BTreeMap<i32, i64>> {
        let topic = self.topic(name, false).await?;
        let partitions: Vec<i32> = match partition {
            Some(partition) if topic.leaders.contains_key(&partition) => vec![partition],
            Some(partition) => {
                return Err(invalid(format!(
                    "Topic {name} has no partition {partition}"
                )));
            }
            None => topic.leaders.keys().copied().collect(),
        };
        let timestamp = match start {
            Start::Offset(offset) => {
                return Ok(partitions.into_iter().map(|p| (p, offset)).collect());
            }
            Start::Earliest => -2,
            Start::Latest => -1,
        };
        let mut positions = BTreeMap::new();
        for (leader, partitions) in by_leader(&topic, &partitions) {
            let mut request = ListOffsetsRequest::default();
            request.replica_id = BrokerId(-1);
            let mut wanted = ListOffsetsTopic::default();
            wanted.name = TopicName(StrBytes::from_string(name.to_string()));
            wanted.partitions = partitions
                .iter()
                .map(|partition| {
                    let mut wanted = ListOffsetsPartition::default();
                    wanted.partition_index = *partition;
                    wanted.current_leader_epoch = -1;
                    wanted.timestamp = timestamp;
                    wanted
                })
                .collect();
            request.topics = vec![wanted];
            let answer = self
                .broker(leader)
                .await?
                .call(&request, LIST_OFFSETS_VERSION)
                .await?;
            for partition in answer
                .topics
                .iter()
                .flat_map(|topic| topic.partitions.iter())
            {
                if partition.error_code != 0 {
                    return Err(error_of(partition.error_code, None));
                }
                positions.insert(partition.partition_index, partition.offset);
            }
        }
        Ok(positions)
    }

    /// The messages after each position, which move past them. Waits briefly for new ones.
    pub async fn fetch(
        &mut self,
        name: &str,
        positions: &mut BTreeMap<i32, i64>,
    ) -> Result<Vec<Value>> {
        let topic = self.topic(name, false).await?;
        let partitions: Vec<i32> = positions.keys().copied().collect();
        let mut messages = Vec::new();
        for (leader, partitions) in by_leader(&topic, &partitions) {
            let mut request = FetchRequest::default();
            request.replica_id = BrokerId(-1);
            request.max_wait_ms = FETCH_WAIT_MS;
            request.min_bytes = 1;
            request.max_bytes = FETCH_BYTES;
            request.session_epoch = -1;
            let mut wanted = FetchTopic::default();
            wanted.topic = TopicName(StrBytes::from_string(name.to_string()));
            wanted.partitions = partitions
                .iter()
                .map(|partition| {
                    let mut wanted = FetchPartition::default();
                    wanted.partition = *partition;
                    wanted.current_leader_epoch = -1;
                    wanted.fetch_offset = positions[partition];
                    wanted.log_start_offset = -1;
                    wanted.partition_max_bytes = PARTITION_BYTES;
                    wanted
                })
                .collect();
            request.topics = vec![wanted];
            let answer = match self
                .broker(leader)
                .await?
                .call(&request, FETCH_VERSION)
                .await
            {
                Ok(answer) => answer,
                Err(error) => {
                    self.forget(leader, name);
                    return Err(error);
                }
            };
            if answer.error_code != 0 {
                return Err(error_of(answer.error_code, None));
            }
            for partition in answer
                .responses
                .iter()
                .flat_map(|topic| topic.partitions.iter())
            {
                if STALE_LEADER.contains(&partition.error_code) {
                    self.forget(leader, name);
                    continue;
                }
                if partition.error_code != 0 {
                    return Err(error_of(
                        partition.error_code,
                        Some(format!("partition {}", partition.partition_index)),
                    ));
                }
                let Some(position) = positions.get_mut(&partition.partition_index) else {
                    continue;
                };
                for record in decode(partition.records.clone())? {
                    // A batch may start before the position asked for.
                    if record.offset < *position || record.control {
                        continue;
                    }
                    *position = record.offset + 1;
                    if messages.len() < MAX_MESSAGES {
                        messages.push(consumed(name, partition.partition_index, &record));
                    }
                }
            }
        }
        Ok(messages)
    }
}

/// The records of a fetched partition. The last batch may be cut at the size limit: it is
/// left for the next fetch.
pub(super) fn decode(records: Option<Bytes>) -> Result<Vec<Record>> {
    let Some(mut buffer) = records else {
        return Ok(Vec::new());
    };
    let mut decoded = Vec::new();
    while !buffer.is_empty() {
        match RecordBatchDecoder::decode_with_custom_compression(&mut buffer, Some(decompress)) {
            Ok(set) => decoded.extend(set.records),
            Err(error) if decoded.is_empty() && buffer.len() > 61 => {
                return Err(invalid(format!("Cannot read the messages: {error}")));
            }
            Err(_) => break,
        }
    }
    Ok(decoded)
}

/// Decompresses a batch: none, gzip and snappy with the codec's own code, lz4 and zstd with
/// pure-Rust decoders, so no C compression library is built.
pub(super) fn decompress(buffer: &mut Bytes, compression: Compression) -> anyhow::Result<Bytes> {
    use bytes::Buf;
    use kafka_protocol::compression::{Decompressor, Gzip, None as Plain, Snappy};
    let all = |buffer: &mut Bytes| Ok(buffer.copy_to_bytes(buffer.remaining()));
    let read = |reader: &mut dyn Read| -> anyhow::Result<Bytes> {
        let mut output = Vec::new();
        reader.take(MAX_DECOMPRESSED).read_to_end(&mut output)?;
        Ok(Bytes::from(output))
    };
    match compression {
        Compression::None => Plain::decompress(buffer, all),
        Compression::Gzip => Gzip::decompress(buffer, all),
        Compression::Snappy => Snappy::decompress(buffer, all),
        Compression::Lz4 => read(&mut lz4_flex::frame::FrameDecoder::new(buffer.as_ref())),
        Compression::Zstd => read(&mut ruzstd::decoding::StreamingDecoder::new(
            buffer.as_ref(),
        )?),
    }
}

/// Bytes as text when they are UTF-8, otherwise `{"$binary": base64}`.
pub(super) fn shown(bytes: &Option<Bytes>) -> Value {
    match bytes {
        None => Value::Null,
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Value::String(text.to_string()),
            Err(_) => json!({"$binary": STANDARD.encode(bytes)}),
        },
    }
}
/// Text as bytes; `{"$binary": base64}` as the bytes it holds.
pub fn bytes_of(text: &str) -> Result<Bytes> {
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text.trim())
        && object.len() == 1
        && let Some(encoded) = object.get("$binary").and_then(Value::as_str)
    {
        return STANDARD
            .decode(encoded)
            .map(Bytes::from)
            .map_err(|_| invalid("A $binary value must be base64"));
    }
    Ok(Bytes::from(text.to_string()))
}

pub(super) fn consumed(topic: &str, partition: i32, record: &Record) -> Value {
    let headers: Map<String, Value> = record
        .headers
        .iter()
        .map(|(name, value)| (name.to_string(), shown(value)))
        .collect();
    json!({
        "topic": topic,
        "partition": partition,
        "offset": record.offset,
        "timestamp": record.timestamp,
        "key": shown(&record.key),
        "value": shown(&record.value),
        "headers": headers,
    })
}
