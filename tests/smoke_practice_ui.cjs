const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');

const root = resolve(__dirname, '..');
const images = resolve(root, process.env.PAW_SMOKE_SCREENSHOTS || '.local/verification/practice-smoke');
const reviewed = JSON.parse(readFileSync(join(root, 'app/content/arena/practice-reviews.json'), 'utf8'));
const privateDirectory = mkdtempSync(join(tmpdir(), 'paw-practice-smoke-'));
const sessionToken = randomUUID();
const offline = process.env.PAW_SMOKE_OFFLINE === '1';
const startup = `
import hashlib
import os
import time
import server
uid = server.ACCOUNTS.create('agent_smoke_student', '测试宝宝', os.environ['PAW_SMOKE_SESSION'])
with server.db() as conn:
    token = hashlib.sha256(os.environ['PAW_SMOKE_SESSION'].encode()).hexdigest()
    conn.execute('INSERT INTO sessions VALUES(?,?,?)', (token, uid, int(time.time()) + 900))
class SmokeHandler(server.Handler):
    def log_request(self, *args):
        pass
app = server.AppHTTPServer(('127.0.0.1', 0), SmokeHandler)
server.PORT = app.server_port
print(app.server_port, flush=True)
app.serve_forever()
`;

function startServer() {
  const env = {
    ...process.env,
    PYTHONPATH: join(root, 'app'),
    BANXUEPAW_DATA_DIR: privateDirectory,
    BANXUEPAW_ENV_FILE: offline ? join(privateDirectory, 'unused.env') : join(root, '.env.local'),
    BANXUEPAW_MATERIALS_DIR: join(root, '教材'),
    BANXUEPAW_ARENA_DATA: join(root, 'app', 'arena-data.bwa'),
    PAW_SMOKE_SESSION: sessionToken,
    PORT: '0',
  };
  delete env.SECURE_COOKIES;
  delete env.APP_PUBLIC_URL;
  return spawn(join(root, '.venv', 'bin', 'python'), ['-c', startup], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function serverUrl(server) {
  return new Promise((resolveUrl, reject) => {
    const output = createInterface({input: server.stdout});
    const timer = setTimeout(() => reject(new Error('本地冒烟服务启动超时')), 12000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`冒烟服务退出（${code}）`));
    });
    output.once('line', port => {
      clearTimeout(timer);
      output.close();
      if (/^\d+$/.test(port)) resolveUrl('http://127.0.0.1:' + port);
      else reject(new Error('本地冒烟服务没有返回端口'));
    });
  });
}

(async () => {
  mkdirSync(images, {recursive:true});
  const server = startServer();
  let browser;
  try {
    const base = await serverUrl(server);
    browser = await chromium.launch({headless:true, executablePath:process.env.PAW_SMOKE_CHROME});
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await context.addCookies([{url:base,name:'bx_session',value:sessionToken}]);
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    const verified = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/study\/sessions\/[a-f0-9]+\/jobs$/.test(request.url())) {
        requests.push(request.postDataJSON());
      }
    });
    page.on('response', async response => {
      if (response.ok() && response.request().method() === 'GET' && /\/api\/study\/sessions\/[a-f0-9]+$/.test(response.url())) {
        const data = await response.json().catch(() => null);
        if (data?.kind === 'practice') {
          for (const message of data.messages || []) {
            if (message.role === 'assistant' && message.data?.supportMode === 'model') {
              verified.push(message.data.model);
            }
          }
        }
      }
    });
    const snap = async name => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({path:join(images,name),animations:'disabled'});
    };
    const loadSet = async () => page.evaluate(async () => (await fetch('/api/learning/practice/' + location.hash.split('/').at(-1))).json());

    const welcome = page.waitForResponse(response => response.url().endsWith('/api/daily/welcome'));
    await page.goto(base+'/#/home');
    await page.getByRole('heading',{name:'智能小爪陪你学',exact:true}).waitFor();
    const skip=page.getByRole('button',{name:'跳过',exact:true});
    if ((await (await welcome).json()).show) await skip.click();
    const group = page.getByRole('button',{name:/智能组题/});
    const paper = page.getByRole('button',{name:/智能组卷/});
    await group.waitFor();
    await paper.waitFor();
    assert.ok((await group.boundingBox()).y < 360);
    assert.equal(await page.evaluate(async()=> (await (await fetch('/api/health')).json()).practiceConfigured), !offline);
    await snap('01-home.png');
    await paper.click();
    const form=page.locator('#personal-answer-form');
    await form.waitFor();
    const sheet = await loadSet();
    assert.equal(sheet.questions.length, 10);
    assert.equal(sheet.style, 'arena-paper');
    assert.equal(new Set(sheet.questions.map(q=>q.originId)).size, 10);
    assert.ok(sheet.questions.some(q=>q.kind==='choice') && sheet.questions.some(q=>q.kind==='written'));
    await snap('02-paper.png');

    const submit = async (question, wrong = false) => {
      const expected = reviewed[question.originId].answer;
      if (question.kind === 'choice') {
        const id = wrong ? question.optionIds.find(id=>id!==expected[0]) : expected[0];
        await form.locator(`input[value="${id}"]`).check();
      } else {
        const inputs = form.locator('.practice-steps input');
        for (let i=0; i<expected.length; i++) await inputs.nth(i).fill(wrong ? '0' : expected[i]);
      }
      await form.getByRole('button',{name:'提交',exact:true}).click();
      await page.locator('.practice-review').waitFor();
    };
    const advance = async () => form.getByRole('button',{name:'下一题',exact:true}).click();
    const initial = sheet;
    const focusIndex = initial.questions.findIndex(q=>q.steps?.length === 2);
    assert.ok(focusIndex >= 0 && focusIndex < 9);
    for (const question of initial.questions.slice(0, focusIndex)) {
      await submit(question, question.pointTitle === '多位数乘法');
      await advance();
    }

    const focus = initial.questions[focusIndex];
    const inputs = form.locator('.practice-steps input');
    const [first] = reviewed[focus.originId].answer;
    const wrongSecond = '0';
    const scratch = '我按第一步算出了前面的量，第二步直接填了零。';
    await inputs.nth(0).fill(first);
    await inputs.nth(1).fill(wrongSecond);
    await page.getByText('写草稿',{exact:true}).click();
    await page.getByRole('textbox',{name:'算式或解题草稿'}).fill(scratch);
    const capsule = page.locator('#practice-dock');
    await capsule.waitFor();
    await page.getByRole('textbox',{name:'算式或解题草稿'}).blur();
    await snap('03-capsule.png');
    await capsule.click();
    const dialog = page.getByRole('dialog',{name:'问爪爪'});
    const replies = dialog.locator('.study-message.assistant:has(> small) .chat-rich');
    await dialog.getByRole('textbox',{name:'你的问题或想法'}).fill('结合我的草稿，提示下一步怎么做。');
    await dialog.getByRole('button',{name:'发送',exact:true}).click();
    await replies.first().waitFor({timeout:60000});
    assert.deepEqual(requests[0].practiceWork,{answers:[first,wrongSecond],scratch});
    const hint=await replies.first().innerText();
    assert.ok(hint.length > 5);
    if (!offline) assert.doesNotMatch(hint,/\d/);
    const box=await dialog.boundingBox();
    assert.ok(Math.abs(box.x+box.width/2-195)<4);
    assert.ok(Math.abs(box.y+box.height/2-422)<4);
    await snap('04-hint.png');
    await dialog.getByRole('button',{name:'关闭问爪爪'}).click();
    await dialog.waitFor({state:'hidden'});
    await capsule.waitFor();
    assert.equal(await inputs.nth(1).inputValue(),wrongSecond);
    assert.equal(await page.getByRole('textbox',{name:'算式或解题草稿'}).inputValue(),scratch);
    await form.getByRole('button',{name:'提交',exact:true}).click();
    await page.locator('.practice-review').waitFor();
    await page.getByRole('button',{name:'请爪爪验算',exact:true}).click();
    await replies.nth(1).waitFor({timeout:60000});
    const response=await replies.last().innerText();
    if (!offline) {
      assert.match(response,/第 1 步 · 答对了/);
      assert.match(response,new RegExp('第 2 步 · 你填了 '+wrongSecond+'，参考答案是'));
      assert.ok(verified.some(model=>model.includes('gpt-')));
    } else assert.match(response,/第 1 步/);
    await snap('05-review.png');
    await page.setViewportSize({width:320,height:740});
    const narrow=await dialog.boundingBox();
    assert.ok(narrow.x>=0 && narrow.x+narrow.width<=320);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    for (const question of initial.questions.slice(focusIndex + 1, -1)) {
      await advance();
      await submit(question, question.pointTitle === '多位数乘法');
    }
    await page.goto(base+'/#/learn/analysis');
    await page.getByText('再做 1 道已批改的题，就能看到知识图。').waitFor();
    assert.equal(await page.locator('.analysis-charts').count(), 0);
    await snap('06-analysis-before.png');

    await page.goto(base+'/#/learn/practice/'+initial.id);
    await form.waitFor();
    await submit(initial.questions.at(-1), true);
    await form.getByRole('button',{name:'查看结果',exact:true}).click();
    await page.getByRole('button',{name:'看分析',exact:true}).click();
    await page.locator('.analysis-ring').waitFor();
    assert.equal(await page.locator('.analysis-triangle').count(), 1);
    await page.setViewportSize({width:390,height:844});
    await snap('07-analysis.png');
    await page.setViewportSize({width:320,height:740});
    await page.locator('.analysis-points button').first().click();
    await page.getByRole('button',{name:'全部记录',exact:true}).waitFor();
    const record = page.locator('.analysis-records li a').first();
    const recordUrl = await record.getAttribute('href');
    await snap('08-records.png');
    await record.click();
    await form.waitFor();
    assert.equal(new URL(page.url()).hash, recordUrl);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.goto(base+'/#/learn/practice/'+initial.id);
    await page.getByRole('button',{name:'按薄弱点组下一组',exact:true}).click();
    await form.waitFor();
    const adjusted=await loadSet();
    assert.equal(adjusted.sourceSetId,initial.id);
    assert.ok(adjusted.questions.every(q=>reviewed[q.originId]));
    assert.deepEqual(errors,[]);
    console.log('Browser smoke passed. Home, Arena papers, ten-question analysis, records and 320px checks passed.');
    if (!offline) console.log('Verified model:', [...new Set(verified)].join(', '));
  } finally {
    await browser?.close();
    await new Promise(resolveExit => {
      if (server.exitCode !== null || server.signalCode !== null) return resolveExit();
      server.once('close', resolveExit);
      server.kill();
    });
    rmSync(privateDirectory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
