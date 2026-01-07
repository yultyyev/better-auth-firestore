/**
 * Generate a Firebase Console URL for creating the required Firestore composite index.
 * This URL will pre-fill the index creation form with the correct configuration,
 * similar to the URLs provided in Firestore error messages.
 *
 * @param projectId - Your Firebase project ID
 * @param databaseId - Your Firestore database ID (defaults to "(default)")
 * @param collectionName - The collection name (defaults to "verification")
 * @returns A Firebase Console URL with pre-filled index configuration
 */
export function generateIndexSetupUrl(
	projectId: string,
	databaseId: string = "(default)",
	collectionName: string = "verification",
): string {
	// For protobuf, use the original format (keep (default) as-is)
	const protobufDatabaseId = databaseId;
	
	// Construct the index resource path for protobuf
	// Format: projects/{projectId}/databases/{databaseId}/collectionGroups/{collectionName}/indexes/
	const indexPath = `projects/${projectId}/databases/${protobufDatabaseId}/collectionGroups/${collectionName}/indexes/`;

	// Build protobuf-encoded message
	// Based on Firebase's actual error message format:
	// Field 1 (tag 0x0a, wire type 2): parent path (string)
	const pathTag = Buffer.from([0x0a]); // Field 1, wire type 2
	const pathLength = Buffer.from([indexPath.length]);
	const pathData = Buffer.from(indexPath, "utf8");
	
	// Field 2 (tag 0x10, wire type 0): query scope (1 = COLLECTION)
	const scopeTag = Buffer.from([0x10, 0x01]); // Field 2, value 1
	
	// Field 3 (tag 0x1a, wire type 2): fields array - identifier
	const identifierField = Buffer.concat([
		Buffer.from([0x1a, 0x0e]), // Field 3, length 14
		Buffer.from([0x0a, 0x0a]), // Nested field 1, length 10
		Buffer.from("identifier", "utf8"),
		Buffer.from([0x10, 0x01]), // Nested field 2, value 1 (ASCENDING)
	]);
	
	// Field 4 (tag 0x1a, wire type 2): fields array - createdAt
	const createdAtField = Buffer.concat([
		Buffer.from([0x1a, 0x0d]), // Field 3, length 13
		Buffer.from([0x0a, 0x09]), // Nested field 1, length 9
		Buffer.from("createdAt", "utf8"),
		Buffer.from([0x10, 0x02]), // Nested field 2, value 2 (DESCENDING)
	]);
	
	// Field 5 (tag 0x1a, wire type 2): fields array - __name__
	const nameField = Buffer.concat([
		Buffer.from([0x1a, 0x0c]), // Field 3, length 12
		Buffer.from([0x0a, 0x08]), // Nested field 1, length 8
		Buffer.from("__name__", "utf8"),
		Buffer.from([0x10, 0x02]), // Nested field 2, value 2 (DESCENDING)
	]);
	
	// Combine all parts
	const protobuf = Buffer.concat([
		pathTag,
		pathLength,
		pathData,
		scopeTag,
		identifierField,
		createdAtField,
		nameField,
	]);

	const createComposite = protobuf.toString("base64");

	// For default database, omit the database path entirely
	if (databaseId === "(default)") {
		return `https://console.firebase.google.com/project/${projectId}/firestore/indexes?create_composite=${createComposite}`;
	}
	
	// For custom databases, include the database path (convert (default) to -default- format)
	const urlDatabaseId = databaseId === "(default)" ? "-default-" : databaseId;
	return `https://console.firebase.google.com/project/${projectId}/firestore/databases/${urlDatabaseId}/indexes?create_composite=${createComposite}`;
}

/**
 * Get the index configuration object for the verification collection.
 * This can be used to create firestore.indexes.json file.
 */
export function getIndexConfig(collectionName: string = "verification") {
	return {
		indexes: [
			{
				collectionGroup: collectionName,
				queryScope: "COLLECTION",
				fields: [
					{
						fieldPath: "identifier",
						order: "ASCENDING",
					},
					{
						fieldPath: "createdAt",
						order: "DESCENDING",
					},
					{
						fieldPath: "__name__",
						order: "DESCENDING",
					},
				],
			},
		],
		fieldOverrides: [],
	};
}

