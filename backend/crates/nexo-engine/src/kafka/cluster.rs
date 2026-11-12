//! The brokers of a cluster and which one leads each partition.
use super::*;

/// A cluster: the bootstrap connection for metadata and one connection per broker.
pub struct Cluster {
    pub(super) settings: Settings,
    pub(super) metadata: Connection,
    pub(super) brokers: HashMap<i32, (String, u16)>,
    pub(super) connections: HashMap<i32, Connection>,
    pub(super) topics: BTreeMap<String, Topic>,
    pub(super) next_partition: usize,
}
impl Cluster {
    /// Connects to the first bootstrap broker that answers and reads the cluster metadata.
    pub async fn connect(settings: Settings) -> Result<Self> {
        let mut failures = Vec::new();
        let mut opened = None;
        for (host, port) in &settings.bootstrap {
            match Connection::open(&settings, host, *port).await {
                Ok(connection) => {
                    opened = Some(connection);
                    break;
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        let metadata = opened.ok_or_else(|| invalid(failures.join("; ")))?;
        let mut cluster = Self {
            settings,
            metadata,
            brokers: HashMap::new(),
            connections: HashMap::new(),
            topics: BTreeMap::new(),
            next_partition: 0,
        };
        cluster.refresh(None, false).await?;
        Ok(cluster)
    }

    /// Reads the metadata of some topics (or all), creating them when the broker allows it.
    pub(super) async fn refresh(&mut self, topics: Option<&[String]>, create: bool) -> Result<()> {
        let mut request = MetadataRequest::default();
        request.topics = topics.map(|names| {
            names
                .iter()
                .map(|name| {
                    let mut topic = MetadataRequestTopic::default();
                    topic.name = Some(TopicName(StrBytes::from_string(name.clone())));
                    topic
                })
                .collect()
        });
        request.allow_auto_topic_creation = create;
        let response = self.metadata.call(&request, METADATA_VERSION).await?;
        self.brokers = response
            .brokers
            .iter()
            .map(|broker| {
                (
                    broker.node_id.0,
                    (broker.host.to_string(), broker.port as u16),
                )
            })
            .collect();
        for topic in response.topics {
            let Some(name) = topic.name.map(|name| name.0.to_string()) else {
                continue;
            };
            if topic.error_code != 0 {
                self.topics.remove(&name);
                if topics.is_some() {
                    return Err(error_of(topic.error_code, Some(name)));
                }
                continue;
            }
            let leaders = topic
                .partitions
                .iter()
                .map(|partition| (partition.partition_index, partition.leader_id.0))
                .collect();
            self.topics.insert(
                name.clone(),
                Topic {
                    name,
                    internal: topic.is_internal,
                    leaders,
                },
            );
        }
        Ok(())
    }

    /// Every topic of the cluster, read again.
    pub async fn topics(&mut self) -> Result<Vec<Topic>> {
        self.topics.clear();
        self.refresh(None, false).await?;
        Ok(self.topics.values().cloned().collect())
    }

    /// A topic's partitions and leaders, read when not known yet.
    pub(super) async fn topic(&mut self, name: &str, create: bool) -> Result<Topic> {
        if !self.topics.contains_key(name) {
            self.refresh(Some(&[name.to_string()]), create).await?;
        }
        self.topics
            .get(name)
            .cloned()
            .filter(|topic| !topic.leaders.is_empty())
            .ok_or_else(|| invalid(format!("Topic {name} has no partitions")))
    }

    /// The connection to a broker, opened through the egress policy when needed.
    pub(super) async fn broker(&mut self, id: i32) -> Result<&mut Connection> {
        if !self.connections.contains_key(&id) {
            let (host, port) = self
                .brokers
                .get(&id)
                .cloned()
                .ok_or_else(|| invalid(format!("The cluster did not describe broker {id}")))?;
            let connection = Connection::open(&self.settings, &host, port).await?;
            self.connections.insert(id, connection);
        }
        Ok(self.connections.get_mut(&id).expect("just inserted"))
    }
    /// Forgets a broker's connection after a failure, and the leaders the metadata gave.
    pub(super) fn forget(&mut self, id: i32, topic: &str) {
        self.connections.remove(&id);
        self.topics.remove(topic);
    }
}

/// The partitions grouped by the broker that leads them.
pub(super) fn by_leader(topic: &Topic, partitions: &[i32]) -> BTreeMap<i32, Vec<i32>> {
    let mut grouped: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for partition in partitions {
        if let Some(leader) = topic.leaders.get(partition) {
            grouped.entry(*leader).or_default().push(*partition);
        }
    }
    grouped
}
