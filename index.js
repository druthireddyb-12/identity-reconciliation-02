import express from "express";
import { pathToFileURL } from "node:url";

export const app = express();
app.use(express.json());

const PORT = 3000;

const contactsDatabase = [];
let nextId = 1;

export const resetContactsDatabase = () => {
    contactsDatabase.length = 0;
    nextId = 1;
};

const isActiveContact = (contact) => contact && contact.deletedAt === null;

const normalizeInput = (email, phoneNumber) => {
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : null;
    const normalizedPhone = phoneNumber === undefined || phoneNumber === null || phoneNumber === "" ? null : String(phoneNumber);
    return { email: normalizedEmail, phoneNumber: normalizedPhone };
};

const findContactById = (contactId) => {
    const contact = contactsDatabase.find((contact) => contact.id === contactId);
    return isActiveContact(contact) ? contact : null;
};

const resolvePrimaryContact = (contactId) => {
    const visited = new Set();
    let currentId = contactId;

    while (currentId) {
        if (visited.has(currentId)) {
            return null;
        }
        visited.add(currentId);

        const contact = findContactById(currentId);
        if (!contact) {
            return null;
        }

        if (contact.linkPrecedence === "primary") {
            return contact;
        }

        currentId = contact.linkedId;
    }

    return null;
};

const collectClusterContacts = (primaryContactId) => {
    const result = [];
    const queue = [primaryContactId];
    const visited = new Set();

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (!currentId || visited.has(currentId)) {
            continue;
        }

        visited.add(currentId);
        const contact = findContactById(currentId);
        if (!contact) {
            continue;
        }

        result.push(contact);

        const childContacts = contactsDatabase.filter((candidate) => candidate.linkedId === currentId);
        childContacts.forEach((child) => queue.push(child.id));
    }

    return result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
};

const repointChildren = (oldPrimaryId, newPrimaryId, updatedAt) => {
    contactsDatabase.forEach((contact) => {
        if (contact.linkedId === oldPrimaryId) {
            contact.linkedId = newPrimaryId;
            contact.updatedAt = updatedAt;
        }
    });
};

const buildResponsePayload = (primaryContact, clusterContacts) => {
    const emails = [];
    const phoneNumbers = [];
    const secondaryContactIds = [];

    const addUniqueValue = (value, targetArray) => {
        if (value && !targetArray.includes(value)) {
            targetArray.push(value);
        }
    };

    addUniqueValue(primaryContact.email, emails);
    addUniqueValue(primaryContact.phoneNumber, phoneNumbers);

    clusterContacts
        .filter((contact) => contact.id !== primaryContact.id)
        .forEach((contact) => {
            addUniqueValue(contact.email, emails);
            addUniqueValue(contact.phoneNumber, phoneNumbers);
            secondaryContactIds.push(contact.id);
        });

    return {
        primaryContactId: primaryContact.id,
        emails,
        phoneNumbers,
        secondaryContactIds,
    };
};

app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
});

app.get("/contacts", (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";

    const clusters = [];
    const visitedPrimaryIds = new Set();

    contactsDatabase.forEach((contact) => {
        if (contact.linkPrecedence !== "primary") {
            return;
        }

        if (visitedPrimaryIds.has(contact.id)) {
            return;
        }
        visitedPrimaryIds.add(contact.id);

        const clusterContacts = collectClusterContacts(contact.id);
        const clusterPayload = {
            primaryContactId: contact.id,
            contacts: clusterContacts,
        };

        if (!search) {
            clusters.push(clusterPayload);
            return;
        }

        const haystack = JSON.stringify(clusterContacts).toLowerCase();
        if (haystack.includes(search)) {
            clusters.push(clusterPayload);
        }
    });

    res.status(200).json({ contacts: clusters });
});

app.post("/identify", (req, res) => {
    const { email, phoneNumber } = normalizeInput(req.body?.email, req.body?.phoneNumber);

    if (!email && !phoneNumber) {
        return res.status(400).json({ error: "Missing email or phoneNumber" });
    }

    const matchedContacts = contactsDatabase.filter((contact) => {
        const emailMatches = Boolean(email) && contact.email === email;
        const phoneMatches = Boolean(phoneNumber) && contact.phoneNumber === phoneNumber;
        return emailMatches || phoneMatches;
    });

    const now = new Date().toISOString();

    if (matchedContacts.length === 0) {
        const newPrimary = {
            id: nextId++,
            phoneNumber,
            email,
            linkedId: null,
            linkPrecedence: "primary",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };

        contactsDatabase.push(newPrimary);
        return res.status(200).json({
            contact: buildResponsePayload(newPrimary, [newPrimary]),
        });
    }

    const resolvedPrimaries = matchedContacts
        .map((contact) => resolvePrimaryContact(contact.id))
        .filter(Boolean);

    const uniquePrimaries = [];
    const seenPrimaryIds = new Set();
    resolvedPrimaries.forEach((primary) => {
        if (!seenPrimaryIds.has(primary.id)) {
            seenPrimaryIds.add(primary.id);
            uniquePrimaries.push(primary);
        }
    });

    let primaryContact = uniquePrimaries[0] || null;

    if (uniquePrimaries.length > 1) {
        const sortedPrimaries = uniquePrimaries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        const oldestPrimary = sortedPrimaries[0];
        const youngerPrimaries = sortedPrimaries.slice(1);

        youngerPrimaries.forEach((secondaryPrimary) => {
            const targetPrimary = findContactById(secondaryPrimary.id);
            if (!targetPrimary) {
                return;
            }

            targetPrimary.linkPrecedence = "secondary";
            targetPrimary.linkedId = oldestPrimary.id;
            targetPrimary.updatedAt = now;
            repointChildren(targetPrimary.id, oldestPrimary.id, now);
        });

        primaryContact = oldestPrimary;
    }

    if (!primaryContact) {
        return res.status(500).json({ error: "Unable to resolve primary contact" });
    }

    const clusterContacts = collectClusterContacts(primaryContact.id);
    const knownEmails = new Set(clusterContacts.map((contact) => contact.email).filter(Boolean));
    const knownPhones = new Set(clusterContacts.map((contact) => contact.phoneNumber).filter(Boolean));

    const shouldCreateSecondary = Boolean(email && !knownEmails.has(email)) || Boolean(phoneNumber && !knownPhones.has(phoneNumber));

    if (shouldCreateSecondary) {
        const newSecondary = {
            id: nextId++,
            phoneNumber,
            email,
            linkedId: primaryContact.id,
            linkPrecedence: "secondary",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
        contactsDatabase.push(newSecondary);
    }

    const updatedClusterContacts = collectClusterContacts(primaryContact.id);
    return res.status(200).json({
        contact: buildResponsePayload(primaryContact, updatedClusterContacts),
    });
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
    app.listen(PORT, () => {
        console.log("Server running on port " + PORT);
    });
}

export default app;
