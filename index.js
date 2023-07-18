export class Claude {
    constructor({ sessionKey, proxy, fetch }) {
        this.ready = false;
        if (typeof proxy === 'string') {
            const HOST = proxy;
            this.proxy = ({ endpoint, options }) => ({ endpoint: HOST + endpoint, options })
        } else if (typeof proxy === 'function') {
            this.proxy = proxy;
        } else if (proxy) {
            console.log('Proxy supported formats:\n\t({ endpoint /* endpoint (path) */, options /* fetch options */ }) => { endpoint /* full url */, options /* fetch options */ }');
            console.log('Received proxy: ' + proxy);
            throw new Error('Proxy must be a string (host) or a function');
        }
        if (!this.proxy) {
            this.proxy = ({ endpoint, options }) => ({ endpoint: 'https://claude.ai' + endpoint, options });
        }
        if (!sessionKey) {
            throw new Error('Session key required');
        }
        if (!sessionKey.startsWith('sk-ant-sid01')) {
            throw new Error('Session key invalid: Must be in the format sk-ant-sid01-*****');
        }
        if (fetch) { this.fetch = fetch }
        this.sessionKey = sessionKey;
    }
    models() {
        return ['claude-2', 'claude-1.3', 'claude-instant', 'claude-instant-100k']
    }
    totalTokens(model) {
        // TODO: Figure out if this is correct, the blog article said "We’ve expanded Claude’s context window from 9K to 100K tokens"
        const TOKENS = {
            "claude-2": 100_000,
            "claude-1.3": 9000,
            "claude-instant": 9000,
            "claude-instant-100k": 100_000
        }
        return TOKENS[model || this.defaultModel()];
    }
    defaultModel() {
        return this.models()[0];
    }
    async sendMessage(message, { conversation = null, temporary = true, ...params }) {
        if (!conversation) {
            let out;
            let convo = await this.startConversation(message, {
                ...params,
                done: (a) => {
                    if (params.done) {
                        params.done(a);
                    }
                    out = a;
                }
            })
            if (temporary) { await convo.delete(); }
            return out;
        } else {
            return await this.getConversation(conversation).sendMessage(message, {
                ...params,
            })
        }
    }
    request(endpoint, options) {
        // Can't figure out a way to test this so I'm just assuming it works
        if (!(this.fetch || globalThis.fetch)) {
            throw new Error(`No fetch available in your environment. Use node-18 or later, a modern browser, or add the following code to your project:\n\nimport "isomorphic-fetch";\nconst claude = new Claude({fetch: fetch, sessionKey: "sk-ant-sid01-*****"});`);
        }
        if (!this.proxy) {
            this.proxy = ({ endpoint, options }) => ({ endpoint: 'https://claude.ai' + endpoint, options });
        }
        if (typeof this.proxy === 'string') {
            const HOST = this.proxy;
            this.proxy = ({ endpoint, options }) => ({ endpoint: HOST + endpoint, options })
        }
        const proxied = this.proxy({ endpoint, options });
        return (this.fetch || globalThis.fetch)(proxied.endpoint, proxied.options);
    }
    async init() {
        const organizations = await this.getOrganizations();
        if (organizations.error) {
            throw new Error(JSON.stringify(organizations, null, 2))
        }
        this.organizationId = organizations[0].uuid;
        this.recent_conversations = await this.getConversations();
        this.ready = true;
    }

    async getOrganizations() {
        const response = await this.request("/api/organizations", {
            headers: {
                "content-type": "application/json",
                "cookie": `sessionKey=${this.sessionKey}`
            }
        });
        return await response.json().catch(errorHandle("getOrganizations"));
    }
    async clearConversations() {
        const convos = await this.getConversations();
        return Promise.all(convos.map(i => i.delete()))
    }
    async startConversation(message, params = {}) {
        const { uuid: convoID, name, summary, created_at, updated_at } = await this.request(`/api/organizations/${this.organizationId}/chat_conversations`, {
            headers: {
                "content-type": "application/json",
                "cookie": `sessionKey=${this.sessionKey}`
            },
            method: 'POST',
            body: JSON.stringify({
                name: '',
                uuid: uuid(),
            })
        }).then(r => r.json()).catch(errorHandle("startConversation create"));
        const convo = new Conversation(this, { conversationId: convoID, name, summary, created_at, updated_at });
        await convo.sendMessage(message, params)
        await this.request(`/api/generate_chat_title`, {
            headers: {
                "content-type": "application/json",
                "cookie": `sessionKey=${this.sessionKey}`
            },
            body: JSON.stringify({
                organization_uuid: this.organizationId,
                conversation_uuid: convoID,
                message_content: message,
                recent_titles: this.recent_conversations.map(i => i.name),
            }),
            method: 'POST'
        }).then(r => r.json()).catch(errorHandle("startConversation generate_chat_title"));
        return convo;
    }
    async getConversation(id) {
        if (id instanceof Conversation || id.conversationId) {
            return new Conversation(this, { conversationId: id.conversationId })
        }
        return new Conversation(this, { conversationId: id })
    }
    async getConversations() {
        const response = await this.request(`/api/organizations/${this.organizationId}/chat_conversations`, {
            headers: {
                "content-type": "application/json",
                "cookie": `sessionKey=${this.sessionKey}`
            }
        });
        const json = await response.json();
        return json.map(convo => new Conversation(this, { conversationId: convo.uuid, ...convo }));
    }
    async uploadFile(file) {
        const { content, isText } = await readAsText(file);
        if (isText) {
            console.log(`Extracted ${content.length} characters from ${file.name}`);
            return {
                "file_name": file.name,
                "file_type": file.type,
                "file_size": file.size,
                "extracted_content": content,
            }
        }
        const fd = new FormData();
        fd.append('file', file, file.name);
        fd.append('orgUuid', this.organizationId);
        const response = await this.request('/api/convert_document', {
            headers: {
                "cookie": `sessionKey=${this.sessionKey}`,
            },
            method: 'POST',
            body: fd
        });
        let json;
        try {
            json = await response.json();
        } catch (e) {
            console.log("Couldn't parse JSON", response.status)
            throw new Error('Invalid response when uploading ' + file.name);
        }
        if (response.status !== 200) {
            console.log('Status not 200')
            throw new Error('Invalid response when uploading ' + file.name);
        }
        if (!json.hasOwnProperty('extracted_content')) {
            console.log(json);
            throw new Error('Invalid response when uploading ' + file.name);
        }
        console.log(`Extracted ${json.extracted_content.length} characters from ${file.name}`);
        return json;
    }
}

export class Conversation {
    constructor(claude, { model, conversationId, name = "", summary = "", created_at, updated_at }) {
        this.claude = claude;
        this.conversationId = conversationId;
        this.request = claude.request;
        if (!this.claude) {
            throw new Error('Claude not initialized');
        }
        if (!this.claude.sessionKey) {
            throw new Error('Session key required');
        }
        if (!this.conversationId) {
            throw new Error('Conversation ID required');
        }
        this.model = model || this.claude.defaultModel();
        Object.assign(this, { name, summary, created_at: created_at || new Date().toISOString(), updated_at: updated_at || new Date().toISOString() })
    }
    toJSON() {
        return {
            conversationId: this.conversationId,
            uuid: this.conversationId,
            name: this.name,
            summary: this.summary,
            created_at: this.created_at,
            updated_at: this.updated_at,
            model: this.model,
        }
    }
    async retry(params) {
        return this.sendMessage("", { ...params, retry: true });
    }
    async sendMessage(message, { retry = false, timezone = "America/New_York", attachments = [], model, done = () => { }, progress = () => { }, rawResponse = () => { } } = {}) {
        const body = {
            organization_uuid: this.claude.organizationId,
            conversation_uuid: this.conversationId,
            text: message,
            attachments,
            completion: {
                prompt: message,
                timezone,
                model: model || this.model,
            }
        };
        const response = await this.request(`/api/${retry ? "retry_message" : "append_message"}`, {
            method: "POST",
            headers: {
                "accept": "text/event-stream,text/event-stream",
                "content-type": "application/json",
                "cookie": `sessionKey=${this.claude.sessionKey}`
            },
            body: JSON.stringify(body)
        });
        let resolve;
        let returnPromise = new Promise(r => (resolve = r));
        let parsed;
        readStream(response, (a) => {
            rawResponse(a);
            if (!a.toString().startsWith('data:')) {
                return;
            }
            try {
                parsed = JSON.parse(a.toString().replace(/^data\:/, '').split('\n\ndata:')[0]?.trim() || "{}");
            } catch (e) {
                return;
            }
            progress(parsed);
            if (parsed.stop_reason === 'stop_sequence') {
                done(parsed);
                resolve(parsed);
            }
        })
        return returnPromise;
    }
    async rename(title) {
        if (!title?.length) {
            throw new Error('Title required');
        }
        return await this.request('/api/rename_chat', {
            method: 'POST',
            headers: {
                "cookie": `sessionKey=${this.claude.sessionKey}`
            },
            body: JSON.stringify({
                conversation_uuid: this.conversationId,
                organization_uuid: this.claude.organizationId,
                title,
            })
        }).catch(errorHandle("Rename conversation " + this.conversationId));
    }
    async delete() {
        return await this.request(`/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversationId}`, {
            headers: {
                "cookie": `sessionKey=${this.claude.sessionKey}`
            },
            method: 'DELETE'
        }).catch(errorHandle("Delete conversation " + this.conversationId));
    }
    async getInfo() {
        const response = await this.request(`/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversationId}`, {
            headers: {
                "content-type": "application/json",
                "cookie": `sessionKey=${this.claude.sessionKey}`
            }
        });
        return await response.json().then(this.#formatMessages('chat_messages')).catch(errorHandle("getInfo"));
    }
    getFiles() {
        return this.getMessages().then(r => r.map(i => i.attachments)).then(r => r.flat()).catch(errorHandle('getFiles'));
    }
    getMessages() {
        return this.getInfo().then((a) => a.chat_messages).catch(errorHandle("getMessages"));
    }
    #formatMessages(message_key) {
        return (response) => {
            if (!response[message_key]) {
                return response;
            }
            return {
                ...response,
                [message_key]: response[message_key].map(i => new Message({ claude: this.claude, conversation: this }, { ...i })),
            }
        }
    }
}

async function readStream(response, progressCallback) {
    const reader = response.body.getReader();
    let received = 0;
    let chunks = [];
    let loading = true;
    while (loading) {
        const { done, value } = await reader.read();
        if (done) {
            loading = false;
            break;
        }
        chunks.push(value);
        received += value?.length || 0;
        if (value) { progressCallback(new TextDecoder('utf-8').decode(value)); }
    }

    let body = new Uint8Array(received);
    let position = 0;

    for (let chunk of chunks) {
        body.set(chunk, position);
        position += chunk.length;
    }

    return new TextDecoder('utf-8').decode(body);
}

async function readAsText(file) {
    const buf = await file.arrayBuffer();
    // const allow = ['text', 'javascript', 'json', 'html', 'sh', 'xml', 'latex', 'ecmascript']
    const notText = ['doc', 'pdf', 'ppt', 'xls']
    return {
        content: new TextDecoder('utf-8').decode(buf),
        isText: !notText.find(i => file.name.includes(i))
    }
}

function errorHandle(msg) {
    return (e) => {
        console.error(`Error at: ${msg}`)
        console.error(e);
        process.exit(0);
    }
}

function uuid() {
    var h = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    var k = ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', '-', 'x', 'x', 'x', 'x', '-', '4', 'x', 'x', 'x', '-', 'y', 'x', 'x', 'x', '-', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x'];
    var u = '', i = 0, rb = Math.random() * 0xffffffff | 0;
    while (i++ < 36) {
        var c = k[i - 1], r = rb & 0xf, v = c == 'x' ? r : (r & 0x3 | 0x8);
        u += (c == '-' || c == '4') ? c : h[v]; rb = i % 8 == 0 ? Math.random() * 0xffffffff | 0 : rb >> 4
    }
    return u
}


export class Message {
    constructor({ conversation, claude }, { uuid, text, sender, index, updated_at, edited_at, chat_feedback, attachments }) {
        if (!claude) {
            throw new Error('Claude not initialized');
        }
        if (!conversation) {
            throw new Error('Conversation not initialized');
        }
        Object.assign(this, { conversation, claude });
        this.request = claude.request;
        this.json = { uuid, text, sender, index, updated_at, edited_at, chat_feedback, attachments };
        Object.assign(this, this.json);
    }
    toJSON() {
        return this.json;
    }
    get createdAt() {
        return new Date(this.json.created_at);
    }
    get updatedAt() {
        return new Date(this.json.updated_at);
    }
    get editedAt() {
        return new Date(this.json.edited_at);
    }
    get isBot() {
        return this.sender === "assistant";
    }
    async sendFeedback(type, reason = "") {
        const FEEDBACK_TYPES = ["flag/bug", "flag/harmful", "flag/other"];
        if (!FEEDBACK_TYPES.includes(type)) {
            throw new Error("Invalid feedback type, must be one of: " + FEEDBACK_TYPES.join(", "));
        }
        return await this.request(`/api/organizations/${this.claude.organizationId}/chat_conversations/${this.conversation.conversationId}/chat_messages/${this.uuid}/chat_feedback`, {
            "headers": {
                "cookie": `sessionKey=${this.claude.sessionKey}`
            },
            "body": JSON.stringify({
                type,
                reason,
            }),
            "method": "POST",
        }).catch(errorHandle("Send feedback"));
    }
}

export default Claude;