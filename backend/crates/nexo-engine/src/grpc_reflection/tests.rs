use super::*;

#[test]
fn both_versions_of_the_protocol_are_built_in() {
    for version in [Version::V1, Version::V1Alpha] {
        let service = protocol()
            .get_service_by_name(&format!("{}.ServerReflection", version.package()))
            .unwrap();
        let method = service.methods().next().unwrap();
        assert_eq!(method.name(), "ServerReflectionInfo");
        assert!(method.is_client_streaming() && method.is_server_streaming());
    }
    assert_eq!(Version::V1Alpha.name(), "v1alpha");
}

#[test]
fn answers_are_read_from_dynamic_messages() {
    let response = protocol()
        .get_message_by_name("grpc.reflection.v1.ServerReflectionResponse")
        .unwrap();
    let mut answer = DynamicMessage::new(response.clone());
    assert!(list_services(&answer).is_err());
    let mut listed = message_field(&answer, "list_services_response");
    let service_type = listed
        .descriptor()
        .get_field_by_name("service")
        .unwrap()
        .kind()
        .as_message()
        .cloned()
        .unwrap();
    let mut service = DynamicMessage::new(service_type);
    service.set_field_by_name("name", Field::String("demo.Greeter".into()));
    listed.set_field_by_name("service", Field::List(vec![Field::Message(service)]));
    answer.set_field_by_name("list_services_response", Field::Message(listed));
    assert_eq!(list_services(&answer).unwrap(), ["demo.Greeter"]);

    let file = FileDescriptorProto {
        name: Some("demo.proto".into()),
        ..Default::default()
    };
    let mut described = DynamicMessage::new(response);
    let mut files = message_field(&described, "file_descriptor_response");
    files.set_field_by_name(
        "file_descriptor_proto",
        Field::List(vec![Field::Bytes(file.encode_to_vec().into())]),
    );
    described.set_field_by_name("file_descriptor_response", Field::Message(files));
    assert_eq!(file_descriptors(&described).unwrap(), [file]);
}

#[test]
fn well_known_types_fill_imports_a_server_left_out() {
    let files = well_known("google/protobuf/timestamp.proto").unwrap();
    assert!(
        files
            .iter()
            .any(|file| file.name() == "google/protobuf/timestamp.proto")
    );
    assert!(well_known("other/thing.proto").is_none());
    let mut collected = BTreeMap::new();
    add(&mut collected, files).unwrap();
    let mut pool = DescriptorPool::new();
    pool.add_file_descriptor_set(FileDescriptorSet {
        file: collected.into_values().collect(),
    })
    .unwrap();
    assert!(
        pool.get_message_by_name("google.protobuf.Timestamp")
            .is_some()
    );
}
