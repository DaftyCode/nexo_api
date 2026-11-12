//! Producing records: the partition of a key (murmur2, as the Java client) and the request.
use super::*;

impl Cluster {
    /// Produces a message and returns where it was written.
    pub async fn produce(&mut self, message: Outgoing) -> Result<Value> {
        for attempt in 0..2 {
            let topic = self.topic(&message.topic, true).await?;
            let partition = match message.partition {
                Some(partition) if topic.leaders.contains_key(&partition) => partition,
                Some(partition) => {
                    return Err(invalid(format!(
                        "Topic {} has no partition {partition}",
                        topic.name
                    )));
                }
                None => self.partition_for(&topic, message.key.as_deref()),
            };
            let leader = topic.leaders[&partition];
            let request = produce_request(&message, partition)?;
            let answer = match self
                .broker(leader)
                .await?
                .call(&request, PRODUCE_VERSION)
                .await
            {
                Ok(answer) => answer,
                Err(error) => {
                    self.forget(leader, &topic.name);
                    if attempt == 0 {
                        continue;
                    }
                    return Err(error);
                }
            };
            let result = answer
                .responses
                .iter()
                .flat_map(|topic| topic.partition_responses.iter())
                .find(|response| response.index == partition)
                .ok_or_else(|| invalid("The broker did not answer for the partition"))?;
            if STALE_LEADER.contains(&result.error_code) && attempt == 0 {
                self.forget(leader, &topic.name);
                continue;
            }
            if result.error_code != 0 {
                return Err(error_of(
                    result.error_code,
                    result.error_message.as_ref().map(|m| m.to_string()),
                ));
            }
            return Ok(json!({
                "topic": topic.name,
                "partition": partition,
                "offset": result.base_offset,
            }));
        }
        Err(invalid("The partition leader kept changing"))
    }
    /// Java's default partitioner: the murmur2 hash of the key, or each partition in turn.
    pub(super) fn partition_for(&mut self, topic: &Topic, key: Option<&[u8]>) -> i32 {
        let partitions: Vec<i32> = topic.leaders.keys().copied().collect();
        let index = match key {
            Some(key) => (murmur2(key) & 0x7fff_ffff) as usize % partitions.len(),
            None => {
                self.next_partition = self.next_partition.wrapping_add(1);
                self.next_partition % partitions.len()
            }
        };
        partitions[index]
    }
}

pub(super) fn produce_request(message: &Outgoing, partition: i32) -> Result<ProduceRequest> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    let record = Record {
        transactional: false,
        control: false,
        delete_horizon: false,
        partition_leader_epoch: -1,
        producer_id: -1,
        producer_epoch: -1,
        timestamp_type: TimestampType::Creation,
        offset: 0,
        sequence: -1,
        timestamp,
        key: message.key.clone(),
        value: message.value.clone(),
        headers: message
            .headers
            .iter()
            .map(|(name, value)| (StrBytes::from_string(name.clone()), Some(value.clone())))
            .collect::<IndexMap<_, _>>(),
    };
    let mut batch = BytesMut::new();
    RecordBatchEncoder::encode(
        &mut batch,
        [&record],
        &RecordEncodeOptions {
            version: 2,
            compression: Compression::None,
        },
    )
    .map_err(|error| invalid(format!("Cannot encode the message: {error}")))?;
    let mut data = PartitionProduceData::default();
    data.index = partition;
    data.records = Some(batch.freeze());
    let mut topic = TopicProduceData::default();
    topic.name = TopicName(StrBytes::from_string(message.topic.clone()));
    topic.partition_data = vec![data];
    let mut request = ProduceRequest::default();
    // Acknowledged by every in-sync replica, as the Java producer does by default.
    request.acks = -1;
    request.timeout_ms = 15_000;
    request.topic_data = vec![topic];
    Ok(request)
}

/// Kafka's murmur2, as the Java client hashes keys to choose a partition.
pub fn murmur2(data: &[u8]) -> i32 {
    const SEED: u32 = 0x9747_b28c;
    const M: u32 = 0x5bd1_e995;
    let length = data.len();
    let mut h = SEED ^ length as u32;
    let (chunks, rest) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk);
        k = k.wrapping_mul(M);
        k ^= k >> 24;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
    }
    if rest.len() >= 3 {
        h ^= (rest[2] as u32) << 16;
    }
    if rest.len() >= 2 {
        h ^= (rest[1] as u32) << 8;
    }
    if !rest.is_empty() {
        h ^= rest[0] as u32;
        h = h.wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h as i32
}
