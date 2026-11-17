//! A small tree of an XML document: the elements of a showplan, their attributes and their
//! children (text is not used by plans).
use quick_xml::{XmlVersion, events::Event, reader::Reader};

#[derive(Debug, Default)]
pub struct Element {
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub children: Vec<Element>,
}

impl Element {
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|child| child.name == name)
    }
    /// Every element below this one, depth first, without going into a `stop` element.
    pub fn descendants<'a>(&'a self, stop: &str, found: &mut Vec<&'a Element>) {
        for child in &self.children {
            found.push(child);
            if child.name != stop {
                child.descendants(stop, found);
            }
        }
    }
}

/// The name without its namespace prefix.
fn local(name: &str) -> String {
    name.split_once(':')
        .map_or(name, |(_, local)| local)
        .to_owned()
}

fn element(start: &quick_xml::events::BytesStart) -> Option<Element> {
    let mut attributes = Vec::new();
    for attribute in start.attributes() {
        let attribute = attribute.ok()?;
        let value = attribute.normalized_value(XmlVersion::Implicit1_0).ok()?;
        attributes.push((local(attribute.key.as_ref()), value.into_owned()));
    }
    Some(Element {
        name: local(start.name().as_ref()),
        attributes,
        children: Vec::new(),
    })
}

/// The root element of `text`, or nothing when it is not XML.
pub fn parse(text: &str) -> Option<Element> {
    let mut reader = Reader::from_str(text);
    let mut open: Vec<Element> = vec![Element::default()];
    loop {
        match reader.read_event().ok()? {
            Event::Start(start) => open.push(element(&start)?),
            Event::Empty(empty) => {
                let done = element(&empty)?;
                open.last_mut()?.children.push(done);
            }
            Event::End(_) => {
                let done = open.pop()?;
                open.last_mut()?.children.push(done);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut document = open.pop()?;
    if !open.is_empty() || document.children.len() != 1 {
        return None;
    }
    document.children.pop()
}
