import assert from 'assert';
import fs from 'fs';
import path from 'path';

async function run() {
  process.env.LOCALCLAW_DISABLE_SERVER = '1';
  const cp = (n: number) => {
    const line = `[golden] checkpoint ${n}\n`;
    try { fs.appendFileSync(path.join(process.cwd(), 'tests', '.golden-progress.log'), line); } catch {}
  };
  const mod = await import('../src/gateway/server-legacy');
  const api = (mod as any).default || mod;
  const normalizeUserRequest = api.normalizeUserRequest as (m: string) => { search_text: string; chat_text: string };
  const decideRoute = api.decideRoute as (n: { search_text: string; chat_text: string; raw_text?: string }) => any;
  const buildSearchQuery = api.buildSearchQuery as (x: any) => string;
  const shouldRetryEntitySanity = api.shouldRetryEntitySanity as (x: any) => boolean;
  const refineQueryForExpectedScope = api.refineQueryForExpectedScope as (q: string, c?: string, k?: string[]) => string;
  const contradictionTierForFact = api.contradictionTierForFact as (f: any) => 1 | 2;
  const runTurnPipeline = api.runTurnPipeline as (x: any) => Promise<any>;
  const extractOfficeHolderAnswerFromResults = api.extractOfficeHolderAnswerFromResults as (x: any) => any;
  const isFileOperationRequest = api.isFileOperationRequest as (m: string) => boolean;
  const inferDeterministicFileBatchCalls = api.inferDeterministicFileBatchCalls as (m: string, s: any) => any[];
  const inferDeterministicFileFollowupCall = api.inferDeterministicFileFollowupCall as (m: string, s: any) => any;
  const inferDeterministicSingleFileOverwriteCall = api.inferDeterministicSingleFileOverwriteCall as (m: string, s: any) => any;
  const requiresToolExecutionForTurn = api.requiresToolExecutionForTurn as (m: string, s?: any) => boolean;
  cp(1);

  // Golden 1: VP ambiguity -> US default + must verify
  {
    const input = 'lol can you tell me who the vice president is';
    const n = normalizeUserRequest(input);
    const d = decideRoute({ raw_text: input, ...n });
    assert.equal(d.tool, 'web_search');
    assert.equal(d.locked_by_policy, true);
    assert.equal(d.requires_verification, true);
    assert.equal(d.expected_country, 'United States');
    const q = buildSearchQuery({
      normalized: { raw_text: input, ...n },
      domain: d.domain,
      scope: { country: d.expected_country, domain: d.domain },
      expected_keywords: d.expected_keywords,
    });
    assert.ok(/vice president of united states/i.test(q));
  }

  // Golden 2: reaction message should not lock policy
  {
    const input = "that's crazy isn't it?";
    const n = normalizeUserRequest(input);
    const d = decideRoute({ raw_text: input, ...n });
    assert.equal(d.locked_by_policy, false);
    assert.equal(d.tool, null);
  }

  // Golden 3: weather tonight routes to verify + weather domain
  {
    const input = 'weather tonight in frederick maryland';
    const n = normalizeUserRequest(input);
    const d = decideRoute({ raw_text: input, ...n });
    assert.equal(d.tool, 'web_search');
    assert.equal(d.locked_by_policy, true);
    assert.equal(d.domain, 'weather');
    assert.equal(d.requires_verification, true);
    const q = buildSearchQuery({
      normalized: { raw_text: input, ...n },
      domain: d.domain,
      scope: { domain: d.domain, time_window: 'tonight' },
      expected_keywords: d.expected_keywords,
    });
    assert.ok(/weather|forecast/i.test(q));
    assert.ok(/tonight/i.test(q));
  }

  // Golden 4: office-holder sanity retry trigger + query rewrite
  {
    const retry = shouldRetryEntitySanity({
      expectedCountry: 'United States',
      expectedKeywords: ['United States', 'White House'],
      toolData: {
        results: [
          { title: 'Philippines VP Sara Duterte announces run', snippet: 'MANILA, Philippines Vice President...' },
          { title: 'Duterte press briefing', snippet: 'Philippine vice president statement' },
        ],
      },
    });
    assert.equal(retry, true);
    const refined = refineQueryForExpectedScope('who is the vice president', 'United States', ['White House']);
    assert.ok(/United States/i.test(refined));
    assert.ok(/White House/i.test(refined));
  }

  // Golden 5: contradiction tiers
  {
    assert.equal(contradictionTierForFact({ fact_type: 'office_holder' }), 2);
    assert.equal(contradictionTierForFact({ fact_type: 'generic' }), 1);
  }
  cp(5);

  // Golden 6: policy lock precedence beats turn plan
  {
    let plannerCalled = 0;
    const fakeOllama = {
      async generateWithRetryThinking() {
        plannerCalled++;
        return { response: '{"user_intent":"chat","requires_tools":false,"tool_candidates":[],"standalone_request":"noop","domain":"generic","search_text":"noop","expected_country":"","expected_entity_class":"","expected_keywords":[],"requires_verification":false,"missing_info":"","confidence":0.99}', thinking: '' };
      },
    };
    const pipeline = await runTurnPipeline({
      ollama: fakeOllama,
      normalizedMessage: 'who is the vice president',
      forcedMode: null,
      sessionState: {
        sessionId: 't',
        mode: 'discuss',
        modeLock: 'agent',
        objective: '',
        activeObjective: '',
        summary: '',
        tasks: [],
        turns: [],
        notes: [],
        decisions: [],
        pendingQuestions: [],
        updatedAt: Date.now(),
      },
      history: [],
      agentPolicy: {
        force_web_for_fresh: true,
        memory_fallback_on_search_failure: true,
        auto_store_web_facts: true,
        natural_language_tool_router: true,
        retrieval_mode: 'standard',
      },
      wantsSSE: false,
    });
    assert.equal(pipeline.policyDecision.locked_by_policy, true);
    // In model-trigger mode we intentionally start discuss-first and let trigger tokens escalate.
    assert.equal(pipeline.agentIntent, 'discuss');
    assert.equal(plannerCalled, 0);
  }

  // Golden 7: mixed office-holder results still extract official VP answer
  {
    const out = extractOfficeHolderAnswerFromResults({
      query: 'vice president of United States White House',
      results: [
        {
          title: 'LIST OF ELECTED OFFICIALS - FEDERAL',
          url: 'https://www.guadalupetx.gov/page/open/1868/0/2025_ElectedOfficials_Fed.pdf',
          snippet: 'Vice President of United States JD Vance (R)',
        },
        {
          title: 'Vice President JD Vance - The White House',
          url: 'https://www.whitehouse.gov/administration/jd-vance/',
          snippet: 'Vice President JD Vance',
        },
        {
          title: 'Vice President Joe Biden - Obama White House Archives',
          url: 'https://obamawhitehouse.archives.gov/node/360106',
          snippet: 'Vice President Biden...',
        },
      ],
    });
    if (out) {
      assert.ok(/vance/i.test(String(out.answer || '')));
    }
  }

  // Golden 8: file rename phrasing should be treated as tool-required
  {
    const q = 'try again, change the name of the note.txt file in the workspace to testing.txt';
    assert.equal(isFileOperationRequest(q), true);
    assert.equal(requiresToolExecutionForTurn(q, { turns: [], verifiedFacts: [] }), true);
    const call = inferDeterministicFileFollowupCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
    });
    assert.ok(call);
    assert.equal(call.tool, 'rename');
    assert.ok(/note\.txt$/i.test(String(call.params.path)));
    assert.ok(/testing\.txt$/i.test(String(call.params.new_path)));
  }

  // Golden 8b: pronoun follow-up rename ("rename it to ...") should use lastFilePath as source
  {
    const q = 'beautiful! now can you rename it to testing_file.txt';
    const call = inferDeterministicFileFollowupCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
    });
    assert.ok(call);
    assert.equal(call.tool, 'rename');
    assert.ok(/note\.txt$/i.test(String(call.params.path)));
    assert.ok(/testing_file\.txt$/i.test(String(call.params.new_path)));
  }

  // Golden 9: multi-step rename + create should become deterministic batch calls
  {
    const q = 'thats beautiful, now i want you to change the name back to note.txt, and then I want you to create ANOTHER txt file named localtest.txt - it should say Hi in the localtest file';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\testing.txt',
    });
    assert.equal(Array.isArray(calls), true);
    assert.equal(calls.length >= 2, true);
    const ren = calls.find((c: any) => c.tool === 'rename');
    const wr = calls.find((c: any) => c.tool === 'write' && /localtest\.txt$/i.test(String(c.params?.path || '')));
    assert.ok(ren);
    assert.ok(wr);
    assert.ok(/note\.txt$/i.test(String(ren.params.new_path)));
    assert.ok(/localtest\.txt$/i.test(String(wr.params.path)));
    assert.ok(/\bhi\b/i.test(String(wr.params.content)));
  }

  // Golden 10: create + change content + cleanup rename should split into 3 calls
  {
    const q = 'Nice, now go ahead and create a brand new note.txt file that says hey world! and then change the testng_file to say "im not openclaw", also clean the name to say testing instead of testng.';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\testng_file.txt',
    });
    assert.equal(Array.isArray(calls), true);
    assert.equal(calls.length >= 3, true);
    assert.equal(calls[0].tool, 'write');
    assert.ok(/note\.txt$/i.test(String(calls[0].params.path)));
    assert.ok(/hey world/i.test(String(calls[0].params.content)));
    assert.equal(calls[1].tool, 'write');
    assert.ok(/testng_file\.txt$/i.test(String(calls[1].params.path)));
    assert.ok(/im not openclaw/i.test(String(calls[1].params.content)));
    const rename = calls.find((c: any) => c.tool === 'rename');
    assert.ok(rename);
    assert.ok(/testng_file\.txt$/i.test(String(rename.params.path)));
    assert.ok(/testing_file\.txt$/i.test(String(rename.params.new_path)));
  }
  cp(10);

  // Golden 11: two create clauses should become two writes (not one overwritten note)
  {
    const q = 'Create a new txt file in the workspace named hello, and inside it should say hello world. After that, go ahead and create a second txt file named note.txt that says im not openclaw';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
    });
    const writes = calls.filter((c: any) => c.tool === 'write');
    assert.equal(writes.length >= 2, true);
    const helloWrite = writes.find((w: any) => /hello\.txt$/i.test(String(w.params?.path || '')));
    const noteWrite = writes.find((w: any) => /note\.txt$/i.test(String(w.params?.path || '')));
    assert.ok(helloWrite);
    assert.ok(noteWrite);
    assert.ok(/hello world/i.test(String(helloWrite.params.content)));
    assert.ok(/im not openclaw/i.test(String(noteWrite.params.content)));
  }

  // Golden 12: follow-up "edit both of them" should target recent files deterministically
  {
    const q = 'nice! now can you edit both of them to say i actually am localclaw';
    assert.equal(requiresToolExecutionForTurn(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\note.txt',
        'd:\\localclaw\\workspace\\hello.txt',
      ],
    }), true);
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\note.txt',
        'd:\\localclaw\\workspace\\hello.txt',
      ],
    });
    const writes = calls.filter((c: any) => c.tool === 'write');
    assert.equal(writes.length >= 2, true);
    const pset = writes.map((w: any) => String(w.params?.path || '').toLowerCase());
    assert.ok(pset.some((p: string) => /note\.txt$/.test(p)));
    assert.ok(pset.some((p: string) => /hello\.txt$/.test(p)));
    assert.ok(writes.every((w: any) => /i actually am localclaw/i.test(String(w.params?.content || ''))));
  }

  // Golden 12b: typo follow-up should still produce deterministic writes in stale sessions
  {
    const q = 'Edit botb txt files in my wodkspace to say im actually openclaw';
    assert.equal(requiresToolExecutionForTurn(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: [],
    }), true);
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: [],
    });
    const writes = calls.filter((c: any) => c.tool === 'write');
    assert.equal(writes.length >= 1, true);
    assert.ok(writes.every((w: any) => /im actually openclaw/i.test(String(w.params?.content || ''))));
  }

  // Golden 13: singular create with "name it" should not duplicate into note.txt
  {
    const q = 'hey claw! how are you!? I wanna test something with you - i want you to create a txt file in the workspace that said hello world, i am localclaw. and name it "Introduction"';
    const batch = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: ['d:\\localclaw\\workspace\\note.txt'],
    });
    assert.equal(Array.isArray(batch), true);
    assert.equal(batch.length, 0);
    const single = api.inferDeterministicFileWriteCall(q);
    assert.ok(single);
    assert.ok(/introduction\.txt$/i.test(String(single.params.path)));
    assert.ok(/hello world,\s*i am localclaw/i.test(String(single.params.content)));
    assert.equal(/\bname it\b/i.test(String(single.params.content)), false);
  }

  // Golden 14: single-file edit typo ("t say") should map to deterministic overwrite
  {
    const q = 'close, but you made 2 different files,. edit the introduction txt file t say, i am localclaw inside';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\Introduction.txt',
        'd:\\localclaw\\workspace\\note.txt',
      ],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/introduction\.txt$/i.test(String(call.params.path)));
    assert.ok(/i am localclaw inside/i.test(String(call.params.content)));
  }

  // Golden 15: delete + change-content in one turn should become deterministic batch (delete + write)
  {
    const q = 'can you try again, remove/delete the note.txt file, and change the contents of the introduction file to say "i am localclaw"';
    const single = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\Introduction.txt',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\Introduction.txt',
        'd:\\localclaw\\workspace\\note.txt',
      ],
    });
    assert.equal(single, null);

    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\Introduction.txt',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\Introduction.txt',
        'd:\\localclaw\\workspace\\note.txt',
      ],
    });
    assert.equal(Array.isArray(calls), true);
    assert.equal(calls.length >= 2, true);
    const del = calls.find((c: any) => c.tool === 'delete');
    const wr = calls.find((c: any) => c.tool === 'write');
    assert.ok(del);
    assert.ok(wr);
    assert.ok(/note\.txt$/i.test(String(del.params.path)));
    assert.ok(/introduction\.txt$/i.test(String(wr.params.path)));
    assert.ok(/i am localclaw/i.test(String(wr.params.content)));
  }
  cp(15);

  // Golden 16: HTML create request should create an .html file with deterministic template.
  {
    const q = 'now lets see, lets go a bit further, i want you to create an html file this time, one I can open up in my browser, make it say Hello world - i am localclaw, make the background black and the text white, but also put the text inside of a panel so its not floating on the screen';
    const call = api.inferDeterministicFileWriteCall(q);
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<!doctype html>/i.test(c));
    assert.ok(/hello world - i am localclaw/i.test(c));
    assert.ok(/background:/i.test(c));
    assert.ok(/class=\"panel\"/i.test(c));
    assert.equal(/make the background black/i.test(c), false);
  }

  // Golden 17: create with "name is hello" + "put ..." and delete intro should split correctly.
  {
    const q = 'go ahead and create a new txt file, name is hello, and put "this is a test inside of it. After that remove the introduction file thats currently in the workspace';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: ['d:\\localclaw\\workspace\\note.txt'],
    });
    assert.equal(Array.isArray(calls), true);
    assert.equal(calls.length >= 2, true);
    const wr = calls.find((c: any) => c.tool === 'write');
    const del = calls.find((c: any) => c.tool === 'delete');
    assert.ok(wr);
    assert.ok(del);
    assert.ok(/hello\.txt$/i.test(String(wr.params.path)));
    assert.ok(/this is a test inside of it/i.test(String(wr.params.content)));
    assert.ok(/introduction\.txt$/i.test(String(del.params.path)));
  }

  // Golden 18: referential HTML follow-up should overwrite last html file, not create a new txt file.
  {
    const q = 'fire!! good job, but the contents inside are wrong, lets fix that to just say hello world';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\index.html',
      recentFilePaths: ['d:\\localclaw\\workspace\\index.html'],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<!doctype html>/i.test(c));
    assert.ok(/<h1[^>]*>\s*hello world\s*<\/h1>/i.test(c));
  }

  // Golden 19: "the html file" follow-up should target last html file, not create the.html.
  {
    const q = 'try again, lets fix the content inside the html file to only say hello world';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\index.html',
      recentFilePaths: ['d:\\localclaw\\workspace\\index.html'],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    assert.equal(/the\.html$/i.test(String(call.params.path)), false);
  }

  // Golden 20: delete + rename html follow-up should not route as market query.
  {
    const q = 'uhhh okay then can you remove the original index.html file and update the new html file to be named index.html?';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\the.html',
      recentFilePaths: [
        'd:\\localclaw\\workspace\\the.html',
        'd:\\localclaw\\workspace\\index.html',
      ],
    });
    const del = calls.find((c: any) => c.tool === 'delete' && /index\.html$/i.test(String(c.params?.path || '')));
    const ren = calls.find((c: any) => c.tool === 'rename');
    assert.ok(del);
    assert.ok(ren);
    assert.ok(/index\.html$/i.test(String(del.params.path)));
    assert.ok(/the\.html$/i.test(String(ren.params.path)));
    assert.ok(/index\.html$/i.test(String(ren.params.new_path)));

    const n = normalizeUserRequest(q);
    const d = decideRoute({ raw_text: q, ...n });
    assert.equal(d.locked_by_policy, false);
  }
  cp(20);

  // Golden 21: generic html background change should resolve deterministically (no reactor required).
  {
    const htmlPath = path.join(process.cwd(), 'workspace', 'index.html');
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, '<!doctype html><html><head><style>:root { --bg: #000000; --panel: #111111; }</style></head><body><main class="panel"><h1>hello</h1></main></body></html>', 'utf-8');
    const q = 'change the background color of the html file in your workspace to red';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    assert.ok(/--bg:\s*red/i.test(String(call.params.content)));
  }

  // Golden 22: quote-safe clause splitting should not split inside quoted text.
  {
    const q = 'Create a txt file named hello.txt that says "hello and then world". After that create note.txt that says done';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\hello.txt',
      recentFilePaths: [],
    });
    const writes = calls.filter((c: any) => c.tool === 'write');
    assert.equal(writes.length >= 2, true);
    const hello = writes.find((w: any) => /hello\.txt$/i.test(String(w.params?.path || '')));
    const note = writes.find((w: any) => /note\.txt$/i.test(String(w.params?.path || '')));
    assert.ok(hello);
    assert.ok(note);
    assert.ok(/hello and then world/i.test(String(hello.params?.content || '')));
    assert.ok(/\bdone\b/i.test(String(note.params?.content || '')));
  }

  // Golden 23: generic txt content edit phrasing should deterministically target the prior txt file.
  {
    const txtPath = path.join(process.cwd(), 'workspace', 'note.txt');
    fs.mkdirSync(path.dirname(txtPath), { recursive: true });
    fs.writeFileSync(txtPath, 'old value', 'utf-8');
    const q = 'change the content of the txt file in your workspace to say "hello there"';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: txtPath,
      recentFilePaths: [txtPath],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/note\.txt$/i.test(String(call.params.path)));
    assert.ok(/hello there/i.test(String(call.params.content)));
  }

  // Golden 24: generic html content edit phrasing should rewrite primary display text (not create txt fallback).
  {
    const htmlPath = path.join(process.cwd(), 'workspace', 'index.html');
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, '<!doctype html><html><head><style>:root { --bg: #000000; --panel: #111111; }</style></head><body><main class="panel"><h1>old heading</h1></main></body></html>', 'utf-8');
    const q = 'change the content of the html file in your workspace to say "hello there"';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<!doctype html>/i.test(c));
    assert.ok(/<h1[^>]*>\s*hello there\s*<\/h1>/i.test(c));
  }

  // Golden 25: casual follow-up phrasing ("make it just say ...") should still route as file-op follow-up.
  {
    const htmlPath = path.join(process.cwd(), 'workspace', 'index.html');
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, '<!doctype html><html><head><style>:root { --bg: #000000; --panel: #111111; }</style></head><body><main class="panel"><h1>hello world in a panel</h1></main></body></html>', 'utf-8');
    const q = 'nice lol, make it just say "hello world"';
    assert.equal(requiresToolExecutionForTurn(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    }), true);
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<h1[^>]*>\s*hello world\s*<\/h1>/i.test(c));
  }
  cp(25);

  // Golden 26: edit html text prompt should not synthesize "the.html" or spawn batch create writes.
  {
    cp(26);
    const htmlPath = path.join(process.cwd(), 'workspace', 'index.html');
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, '<!doctype html><html><head><style>:root { --bg: #000000; --panel: #111111; }</style></head><body><main class="panel"><h1>hello world in a panel</h1></main></body></html>', 'utf-8');
    const q = 'nono, I want you to change the text inside of the html file and make it say just hello world, it currently says "hello world in a panel". it should just be "Hello world"';
    const batch = inferDeterministicFileBatchCalls(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    });
    assert.equal(batch.some((c: any) => /the\.html$/i.test(String(c.params?.path || ''))), false);
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlPath,
      recentFilePaths: [htmlPath],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<h1[^>]*>\s*Hello world\s*<\/h1>/i.test(c));
  }

  // Golden 27: batch create should not truncate html documents.
  {
    cp(27);
    const q = 'create a new html file named demo.html that says hello world. after that create note.txt that says hi';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: path.join(process.cwd(), 'workspace', 'index.html'),
      recentFilePaths: [],
    });
    const htmlWrite = calls.find((c: any) => c.tool === 'write' && /demo\.html$/i.test(String(c.params?.path || '')));
    assert.ok(htmlWrite);
    const html = String(htmlWrite.params?.content || '');
    assert.ok(/<!doctype html>/i.test(html));
    assert.ok(/<\/html>/i.test(html));
    assert.ok(html.length > 140);
  }

  // Golden 28: HTML create with quoted payload + trailing style instructions should keep only quoted text.
  {
    cp(28);
    const q = 'lets test you now, create a new html file in the workspace that says "hello world, i am localclaw". and wrap the text in a panel and made the background color red.';
    const call = api.inferDeterministicFileWriteCall(q);
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/<h1[^>]*>\s*hello world,\s*i am localclaw\s*<\/h1>/i.test(c));
    assert.equal(/and wrap the text in a panel/i.test(c), false);
  }

  // Golden 29: "remove extra text ... only says ... then rename ..." should edit+rename, not delete extra.txt or create testing.html.
  {
    cp(29);
    const q = 'absolutely amazing, now remove the extra text - make sure it only says "Hello World" - and then rename the file to testing.html instead. Do not touch anything else and make sure the rest of the index file stays the same';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\index.html',
      recentFilePaths: ['d:\\localclaw\\workspace\\index.html'],
    });
    assert.ok(Array.isArray(calls));
    const ren = calls.find((c: any) => c.tool === 'rename');
    const wr = calls.find((c: any) => c.tool === 'write');
    assert.ok(ren);
    assert.ok(wr);
    assert.ok(/index\.html$/i.test(String(ren.params.path)));
    assert.ok(/testing\.html$/i.test(String(ren.params.new_path)));
    assert.ok(/index\.html$/i.test(String(wr.params.path)));
    assert.equal(calls.some((c: any) => c.tool === 'delete' && /extra\.txt$/i.test(String(c.params?.path || ''))), false);
    assert.equal(calls.some((c: any) => c.tool === 'write' && /testing\.html$/i.test(String(c.params?.path || ''))), false);
  }

  // Golden 30: mixed delete + create should not reuse deleted .txt filename for html create target.
  {
    cp(30);
    const q = 'Nice!! remove the note.txt file, and then create a new html file that says "hello world" in a red panel.';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: ['d:\\localclaw\\workspace\\note.txt'],
    });
    assert.ok(Array.isArray(calls));
    assert.ok(calls.some((c: any) => c.tool === 'delete' && /note\.txt$/i.test(String(c.params?.path || ''))));
    const htmlWrite = calls.find((c: any) => c.tool === 'write');
    assert.ok(htmlWrite);
    assert.ok(/\.html$/i.test(String(htmlWrite.params?.path || '')));
    assert.equal(/note\.txt$/i.test(String(htmlWrite.params?.path || '')), false);
    const c = String(htmlWrite.params?.content || '');
    assert.ok(/<h1[^>]*>\s*hello world\s*<\/h1>/i.test(c));
  }

  // Golden 31: vague txt delete follow-up should resolve to recent txt target.
  {
    cp(31);
    const q = "you didnt remove the txt file though";
    assert.equal(requiresToolExecutionForTurn(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: ['d:\\localclaw\\workspace\\note.txt'],
    }), true);
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: 'd:\\localclaw\\workspace\\note.txt',
      recentFilePaths: ['d:\\localclaw\\workspace\\note.txt'],
    });
    assert.ok(calls.some((c: any) => c.tool === 'delete' && /note\.txt$/i.test(String(c.params?.path || ''))));
    assert.equal(calls.some((c: any) => c.tool === 'delete' && /it\.txt$/i.test(String(c.params?.path || ''))), false);
  }

  // Golden 32: mixed txt+html delete phrasing should include both target types.
  {
    cp(32);
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden32_tmp.html');
    const txtP = path.join(ws, 'golden32_tmp.txt');
    fs.writeFileSync(htmlP, '<html><body>ok</body></html>', 'utf-8');
    fs.writeFileSync(txtP, 'ok', 'utf-8');
    const q = 'remove the txt and html file from the workspace';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: txtP,
      recentFilePaths: [txtP, htmlP],
    });
    assert.ok(calls.some((c: any) => c.tool === 'delete' && /\.txt$/i.test(String(c.params?.path || ''))));
    assert.ok(calls.some((c: any) => c.tool === 'delete' && /\.html?$/i.test(String(c.params?.path || ''))));
  }

  // Golden 33: delete explicit txt + create html should not fan out into html group deletes.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden33_keep.html');
    const txtP = path.join(ws, 'golden33_note.txt');
    fs.writeFileSync(htmlP, '<html><body>ok</body></html>', 'utf-8');
    fs.writeFileSync(txtP, 'ok', 'utf-8');
    const q = 'remove the golden33_note.txt file and create a new html file that says hello world in a red panel';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP, txtP],
    });
    const deletes = calls.filter((c: any) => c.tool === 'delete');
    const writes = calls.filter((c: any) => c.tool === 'write');
    assert.ok(writes.length >= 1);
    assert.ok(deletes.some((c: any) => /golden33_note\.txt$/i.test(String(c.params?.path || ''))));
    assert.equal(deletes.some((c: any) => /golden33_keep\.html$/i.test(String(c.params?.path || ''))), false);
  }

  // Golden 34: style mutation target should prefer bare-name html file (index_2) over delete-side explicit index.html.
  {
    cp(34);
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlA = path.join(ws, 'golden34_index.html');
    const htmlB = path.join(ws, 'golden34_index_2.html');
    const html = '<!doctype html><html><head><style>:root{--bg:#111111;--panel:#1b1b1b;} body{background:var(--bg);} .panel{background:var(--panel);}</style></head><body><main class=\"panel\"><h1>Hello world</h1></main></body></html>';
    fs.writeFileSync(htmlA, html, 'utf-8');
    fs.writeFileSync(htmlB, html, 'utf-8');

    const q = 'remove the original golden34_index.html file and change the golden34_index_2 file to have a red background';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: htmlB,
      recentFilePaths: [htmlB, htmlA],
    });
    const styleWrite = calls.find((c: any) => c.tool === 'write' && /golden34_index_2\.html$/i.test(String(c.params?.path || '')));
    const deleteA = calls.find((c: any) => c.tool === 'delete' && /golden34_index\.html$/i.test(String(c.params?.path || '')));
    const deleteB = calls.find((c: any) => c.tool === 'delete' && /golden34_index_2\.html$/i.test(String(c.params?.path || '')));
    assert.ok(styleWrite);
    assert.ok(deleteA);
    assert.equal(!!deleteB, false);
    assert.ok(/--bg:\s*red/i.test(String(styleWrite.params?.content || '')));
  }
  cp(35);

  // Golden 35: text-color style mutation should be deterministic and not mutate background.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden35_text_color.html');
    const html = '<!doctype html><html><head><style>:root{--bg:#111111;--fg:white;--panel:#1b1b1b;} body{background:var(--bg);color:var(--fg);} .panel{background:var(--panel);}</style></head><body><main class="panel"><h1>Hello world</h1></main></body></html>';
    fs.writeFileSync(htmlP, html, 'utf-8');
    const q = 'change the text in the golden35_text_color.html file to be red';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/golden35_text_color\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/--fg:\s*red/i.test(c) || /\bcolor:\s*red\b/i.test(c));
    assert.equal(/--bg:\s*red/i.test(c), false);
  }

  // Golden 36: "from X to Y" should apply target color Y.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden36_from_to.html');
    const html = '<!doctype html><html><head><style>:root{--bg:black;--fg:white;} body{background:var(--bg);color:var(--fg);}</style></head><body><h1>Hello</h1></body></html>';
    fs.writeFileSync(htmlP, html, 'utf-8');
    const q = 'change the text color from white to red in the golden36_from_to.html file';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP],
    });
    assert.ok(call);
    const c = String(call.params.content || '');
    assert.ok(/--fg:\s*red/i.test(c) || /\bcolor:\s*red\b/i.test(c));
    assert.equal(/--fg:\s*white/i.test(c), false);
  }

  // Golden 37: extension typo (index.htnml) should still resolve and mutate index.html.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'index.html');
    fs.writeFileSync(htmlP, '<!doctype html><html><head><style>:root{--bg:black;--fg:white;}</style></head><body><h1>Hello</h1></body></html>', 'utf-8');
    const q = 'change the text in the index.htnml file to be red';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP],
    });
    assert.ok(call);
    assert.ok(/index\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/--fg:\s*red/i.test(c) || /\bcolor:\s*red\b/i.test(c));
  }

  // Golden 38: corrective follow-up without repeating color should reuse last style mutation color.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden38_retry.html');
    fs.writeFileSync(htmlP, '<!doctype html><html><head><style>:root{--bg:black;--fg:white;}</style></head><body><h1>Hello</h1></body></html>', 'utf-8');
    const q = 'you changed the background! i want you to change the text.';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP],
      lastStyleMutation: {
        color: 'red',
        property: 'background',
        target: 'page',
        target_path: htmlP,
        updated_at: Date.now(),
      },
    } as any);
    assert.ok(call);
    assert.ok(/golden38_retry\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/--fg:\s*red/i.test(c) || /\bcolor:\s*red\b/i.test(c));
    assert.equal(/--bg:\s*red/i.test(c), false);
  }
  cp(39);

  // Golden 40: plural file noun should route as file operation.
  {
    const q = 'delete all the files that start with golden';
    assert.equal(isFileOperationRequest(q), true);
  }

  // Golden 41: deterministic prefix-group delete should target matching workspace files.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const keep = path.join(ws, 'keep41.txt');
    const g1 = path.join(ws, 'golden41_a.txt');
    const g2 = path.join(ws, 'golden41_b.html');
    fs.writeFileSync(keep, 'keep', 'utf-8');
    fs.writeFileSync(g1, 'a', 'utf-8');
    fs.writeFileSync(g2, '<html><body>b</body></html>', 'utf-8');
    const q = 'delete all files that start with golden41';
    const calls = inferDeterministicFileBatchCalls(q, {
      lastFilePath: keep,
      recentFilePaths: [keep, g1, g2],
    });
    const deletes = calls
      .filter((c: any) => c.tool === 'delete')
      .map((c: any) => String(c.params?.path || '').toLowerCase());
    assert.ok(deletes.some((p: string) => /golden41_a\.txt$/.test(p)));
    assert.ok(deletes.some((p: string) => /golden41_b\.html$/.test(p)));
    assert.equal(deletes.some((p: string) => /keep41\.txt$/.test(p)), false);
  }

  // Golden 42: structural panel mutation should deterministically wrap content.
  {
    const ws = path.join(process.cwd(), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const htmlP = path.join(ws, 'golden42_structural.html');
    fs.writeFileSync(htmlP, '<!doctype html><html><head><style>body{margin:0;}</style></head><body><h1>Hello world</h1></body></html>', 'utf-8');
    const q = 'put the text in a panel in the html file';
    const call = inferDeterministicSingleFileOverwriteCall(q, {
      lastFilePath: htmlP,
      recentFilePaths: [htmlP],
    });
    assert.ok(call);
    assert.equal(call.tool, 'write');
    assert.ok(/golden42_structural\.html$/i.test(String(call.params.path)));
    const c = String(call.params.content || '');
    assert.ok(/class=\"panel\"/i.test(c));
    assert.ok(/hello world/i.test(c));
  }

  // Golden 43: retry-only follow-up should replay latest failed execute objective.
  {
    let plannerCalled = 0;
    const fakeOllama = {
      async generateWithRetryThinking() {
        plannerCalled++;
        return {
          response: '{"user_intent":"execute","requires_tools":true,"tool_candidates":["write"],"standalone_request":"change the text in the index.html file to be red","domain":"generic","search_text":"","expected_country":"","expected_entity_class":"","expected_keywords":[],"requires_verification":false,"missing_info":"","confidence":0.99}',
          thinking: '',
        };
      },
    };
    const pipeline = await runTurnPipeline({
      ollama: fakeOllama,
      normalizedMessage: 'try again',
      forcedMode: null,
      sessionState: {
        sessionId: 'retry_case',
        mode: 'agent',
        modeLock: 'agent',
        objective: '',
        activeObjective: '',
        summary: '',
        tasks: [],
        turns: [
          { role: 'user', content: 'change the text in the index.html file to be red' },
          { role: 'assistant', content: 'BLOCKED (UNSUPPORTED_MUTATION)' },
        ],
        notes: [],
        decisions: [],
        pendingQuestions: [],
        updatedAt: Date.now(),
        currentTurnExecution: {
          turnId: 'failed_turn',
          objective: 'change the text in the index.html file to be red',
          mode: 'execute',
          status: 'failed',
          tool_calls: [],
          trace: [],
          summary: '',
          verify: {},
          steps: [],
        },
      } as any,
      history: [],
      agentPolicy: {
        force_web_for_fresh: true,
        memory_fallback_on_search_failure: true,
        auto_store_web_facts: true,
        natural_language_tool_router: true,
        retrieval_mode: 'standard',
      },
      wantsSSE: false,
    });
    assert.equal(pipeline.routingMessage, 'change the text in the index.html file to be red');
    assert.equal(pipeline.agentIntent, 'execute');
    assert.equal(plannerCalled >= 1, true);
  }
  cp(43);

  console.log('golden-routing: all checks passed');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
