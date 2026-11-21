const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = resolve(__dirname, '..');
const { PAW_CATALOG_SMOKE_DB: catalogDb, PAW_CATALOG_SMOKE_POINT: point } = process.env;
assert.ok(catalogDb && /^[a-z][a-z0-9-]{2,79}$/.test(point || ''), 'Provide the reviewed local database and knowledge point ID');
const work = mkdtempSync(join(tmpdir(), 'paw-specialty-smoke-'));
const session = randomUUID();
const startup = `
import hashlib, json, os, sqlite3, time
from pathlib import Path

folder = Path(os.environ['BANXUEPAW_DATA_DIR'])
source = Path(os.environ['PAW_CATALOG_SMOKE_DB']).resolve().as_uri() + '?mode=ro'
with sqlite3.connect(source, uri=True) as original, sqlite3.connect(folder/'learning.sqlite3') as isolated:
    original.backup(isolated)

import server
identity = os.environ['PAW_CATALOG_SMOKE_POINT']
point = next(p for p in server.ARENA_BANK.catalog.points() if p['id'] == identity)
answers = {d['originId']: a if d['kind']=='choice' else json.loads(a)
           for _, a, d in server.ARENA_BANK.special_pool(identity, point['grade'])}
uid = server.ACCOUNTS.create('specialty_smoke_student', '专项测试宝宝', os.environ['PAW_SMOKE_SESSION'])
with server.db() as conn:
    token = hashlib.sha256(os.environ['PAW_SMOKE_SESSION'].encode()).hexdigest()
    conn.execute('INSERT INTO sessions VALUES(?,?,?)', (token, uid, int(time.time()) + 600))
    conn.execute('INSERT INTO user_state VALUES(?,?,?)', (uid, 0, json.dumps({'grade': point['grade']})))

class Handler(server.Handler):
    def log_request(self, *_args):
        pass

app = server.AppHTTPServer(('127.0.0.1', 0), Handler)
server.PORT = app.server_port
print(json.dumps({'port':app.server_port,'point':point,'answers':answers}), flush=True)
app.serve_forever()
`;

async function main() {
  const env = {
    ...process.env, PYTHONPATH: join(root, 'app'), PYTHONDONTWRITEBYTECODE: '1',
    BANXUEPAW_DATA_DIR: work, BANXUEPAW_ENV_FILE: join(work, 'unused.env'),
    BANXUEPAW_MATERIALS_DIR: join(root, '教材'), PAW_CATALOG_SMOKE_DB: resolve(catalogDb),
    PAW_SMOKE_SESSION: session, PORT: '0',
  };
  delete env.APP_PUBLIC_URL;
  delete env.SECURE_COOKIES;
  const app = spawn(join(root, '.venv', 'bin', 'python'), ['-c', startup], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = new Promise(done => app.once('close', done));
  let browser;
  try {
    const { port, point: details, answers } = await new Promise((done, fail) => {
      const output = createInterface({ input: app.stdout });
      const guard = setTimeout(() => fail(new Error('本地测试服务启动超时')), 15000);
      app.once('error', error => { clearTimeout(guard); fail(error); });
      app.once('exit', code => { clearTimeout(guard); fail(new Error(`本地测试服务退出 ${code}`)); });
      output.once('line', line => {
        clearTimeout(guard);
        output.close();
        try { done(JSON.parse(line)); } catch (error) { fail(error); }
      });
    });
    const actual = Math.min(Object.keys(answers).length, 20);
    assert.ok(actual > 0, '该知识点尚未发布题目');
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PAW_SMOKE_CHROME });
    const width = Number(process.env.PAW_SMOKE_WIDTH || 390);
    const height = Number(process.env.PAW_SMOKE_HEIGHT || 844);
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    await context.addCookies([{ url: base, name: 'bx_session', value: session }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const welcome = page.waitForResponse(response => response.url().endsWith('/api/daily/welcome'));
    await page.goto(`${base}/#/home`);
    if ((await (await welcome).json()).show) await page.getByRole('button', { name: '跳过', exact: true }).click();
    await page.getByRole('button', { name: '全部知识点', exact: true }).click();
    await page.getByRole('heading', { name: '专项练习', exact: true }).waitFor();
    await page.locator(`button[data-practice-style="arena-specialty"][data-personal-practice="${point}"]`).click();
    await page.getByRole('heading', { name: `${details.name}专项练习`, exact: true }).waitFor();
    const loadSet = async () => {
      const response = await context.request.get(`${base}/api/learning/practice/${page.url().split('/').at(-1)}`);
      assert.ok(response.ok());
      return response.json();
    };
    const set = await loadSet();
    assert.equal(set.targetCount, 20);
    assert.equal(set.questions.length, actual);
    assert.equal(new Set(set.questions.map(q => q.originId)).size, actual);
    assert.ok(set.questions.every(q => q.pointId === point && q.grade === details.grade && q.originId in answers));
    if (actual < 20) {
      const toast = page.locator('#toast.show');
      await toast.waitFor();
      assert.equal(await toast.textContent(), `这组有 ${actual} 道题可练。`);
    }
    assert.equal(await page.locator('.practice-main .practice-plan').count(), 0);
    assert.equal(await page.locator('.practice-heading span').textContent(), `第 1 / ${actual} 题`);
    const getLayout = () => page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        card: box('.practice-main'), footer: box('.practice-footer'), capsule: box('#practice-dock'),
        actions: [...document.querySelectorAll('.practice-footer button')].map(button => button.getBoundingClientRect().toJSON()),
      };
    });
    const initial = await getLayout();
    assert.ok(initial.card.left >= 0 && initial.card.right <= width);
    assert.ok(initial.card.bottom <= initial.capsule.top);
    assert.ok(initial.capsule.bottom <= initial.actions[0].top);
    assert.ok(initial.footer.bottom <= height && initial.footer.bottom >= height - 24);
    assert.equal(initial.actions.length, 3);
    assert.ok(initial.actions.every(action => action.height >= 44 && action.top === initial.actions[0].top));
    assert.equal(await page.locator('.liquid-navigation').isVisible(), false);
    assert.equal(await page.locator('[data-practice-ask]').count(), 0);
    const draft = page.getByRole('textbox', { name: '草稿', exact: true });
    assert.equal(await draft.getAttribute('rows'), '3');
    const compact = await draft.boundingBox();
    assert.ok(compact.height <= 108);
    const gapAfterDraft = initial.footer.top - (compact.y + compact.height);
    assert.ok(gapAfterDraft >= 0 && gapAfterDraft <= 12, `草稿距操作栏 ${gapAfterDraft}px`);
    const samples = [...set.questions].sort((a, b) => b.stem.length - a.stem.length);
    if (process.env.PAW_SMOKE_SCREENSHOTS) {
      mkdirSync(process.env.PAW_SMOKE_SCREENSHOTS, { recursive: true });
      await page.locator('#toast.show').waitFor({ state: 'hidden' });
      for (const kind of ['choice', 'written']) {
        const matching = samples.filter(item => item.kind === kind);
        const question = kind === 'written' ? matching.find(item => item.steps.length >= 2) || matching[0] : matching[0];
        if (!question) continue;
        await page.goto(`${base}/#/learn/practice/${set.id}/${question.id}`);
        await page.getByText(question.stem, { exact: true }).waitFor();
        await page.screenshot({ path: join(process.env.PAW_SMOKE_SCREENSHOTS, `practice-${kind}-${width}x${height}.png`), animations: 'disabled' });
      }
    }

    const longQuestion = samples.find(item => item.steps?.length >= 2) || samples[0];
    const helpQuestion = samples.find(item => item.kind === 'choice') || longQuestion;
    await page.goto(`${base}/#/learn/practice/${set.id}/${helpQuestion.id}`);
    await page.getByText(helpQuestion.stem, { exact: true }).waitFor();
    await draft.fill('先列出已知条件。');
    const helpAnswer = answers[helpQuestion.originId];
    const fields = page.locator('#personal-answer-form input[name="answer"]');
    if (helpQuestion.kind === 'choice') {
      await fields.nth(helpQuestion.optionIds.indexOf(helpAnswer)).check();
    } else {
      for (const [index, value] of helpAnswer.entries()) await fields.nth(index).fill(value);
    }
    await page.getByRole('button', { name: '打开问爪爪' }).click();
    const hintJob = page.waitForRequest(request => request.method() === 'POST' && /\/api\/study\/sessions\/[^/]+\/jobs$/.test(request.url()));
    await page.getByRole('dialog', { name: '问爪爪' }).getByRole('button', { name: '提示', exact: true }).click();
    const hintRequest = await hintJob;
    assert.deepEqual(hintRequest.postDataJSON().practiceWork, { answers: [].concat(helpAnswer), scratch: '先列出已知条件。' });
    assert.ok((await hintRequest.response()).ok());
    await page.getByRole('button', { name: '关闭问爪爪' }).click();
    await page.getByRole('button', { name: '打开问爪爪' }).waitFor();
    await page.goto(`${base}/#/learn/practice/${set.id}/${longQuestion.id}`);
    await page.getByText(longQuestion.stem, { exact: true }).waitFor();
    await draft.fill('先列出已知条件。');
    await page.getByRole('button', { name: '展开', exact: true }).click();
    assert.equal(await draft.getAttribute('rows'), '7');
    assert.ok((await draft.boundingBox()).height > compact.height + 48);
    await page.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await draft.getAttribute('rows'), '3');
    assert.equal(await draft.inputValue(), '先列出已知条件。');
    await page.getByRole('button', { name: '展开', exact: true }).click();
    if (process.env.PAW_SMOKE_SCREENSHOTS && longQuestion.kind === 'written') {
      await page.screenshot({ path: join(process.env.PAW_SMOKE_SCREENSHOTS, `practice-expanded-${width}x${height}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width, height: 480 });
    await page.waitForFunction(() => {
      const card = document.querySelector('.practice-main');
      return card.scrollHeight > card.clientHeight;
    });
    const short = await getLayout();
    const scrollTop = await page.locator('.practice-main').evaluate(card => {
      card.scrollTop = card.scrollHeight;
      return card.scrollTop;
    });
    assert.ok(scrollTop > 0);
    assert.equal((await getLayout()).footer.top, short.footer.top);
    await page.getByRole('button', { name: '打开问爪爪' }).click();
    const dialog = page.getByRole('dialog', { name: '问爪爪' });
    await dialog.waitFor();
    for (const label of ['提示', '例题', '教材']) await dialog.getByRole('button', { name: label, exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭问爪爪' }).click();
    await page.getByRole('button', { name: '打开问爪爪' }).waitFor();
    assert.equal(await page.locator('.practice-main').evaluate(card => card.scrollTop), scrollTop);
    assert.equal(await draft.getAttribute('rows'), '7');
    assert.equal(await draft.inputValue(), '先列出已知条件。');
    const rightCapsule = (await getLayout()).capsule;
    const capsuleY = rightCapsule.top + rightCapsule.height / 2;
    await page.mouse.move(rightCapsule.left + rightCapsule.width / 2, capsuleY);
    await page.mouse.down();
    await page.mouse.move(short.card.left + 28, capsuleY, { steps: 8 });
    await page.mouse.up();
    await page.locator('.practice-tools.dock-left').waitFor();
    const snapped = await getLayout();
    assert.ok(snapped.capsule.right < rightCapsule.left && snapped.capsule.top >= snapped.card.bottom);
    assert.equal(snapped.footer.top, short.footer.top);
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/#/learn/practice/${set.id}`);
    await page.reload();
    await page.locator('#personal-answer-form').waitFor();
    assert.deepEqual(await loadSet(), set);
    const first = set.questions[0];
    const responseValue = answers[first.originId];
    const inputs = page.locator('#personal-answer-form input[name="answer"]');
    if (first.kind === 'choice') {
      await inputs.nth(first.optionIds.indexOf(responseValue)).check();
    } else {
      const invalid = await context.request.post(`${base}/api/learning/attempts`, {
        data: { setId: set.id, questionId: first.id, answer: responseValue.map((value, index) => index === 0 ? `${value}元` : value) },
      });
      assert.equal(invalid.status(), 400);
      assert.equal((await invalid.json()).error, '请在每一步填写一个数');
      for (const [index, value] of responseValue.entries()) {
        const fullWidth = value.replace(/[0-9]/g, digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
        await inputs.nth(index).fill(` ${fullWidth} `);
      }
    }
    const submitButton = page.getByRole('button', { name: '提交', exact: true });
    assert.ok(await submitButton.evaluate(button => button.form?.checkValidity()));
    const graded = page.waitForResponse(response => response.url().endsWith('/api/learning/attempts'), { timeout: 10000 });
    await submitButton.click();
    assert.equal((await (await graded).json()).correct, true);
    await page.getByText('答对了', { exact: true }).waitFor();
    if (actual > 1) {
      await page.getByRole('button', { name: '下一题', exact: true }).click();
      assert.equal(await page.locator('.practice-heading span').textContent(), `第 2 / ${actual} 题`);
      await page.getByRole('button', { name: '上一题', exact: true }).click();
      assert.equal(await page.locator('.practice-heading span').textContent(), `第 1 / ${actual} 题`);
    }
    for (const question of set.questions.slice(1)) {
      const result = await context.request.post(`${base}/api/learning/attempts`, {
        data: { setId: set.id, questionId: question.id, answer: answers[question.originId] },
      });
      assert.ok(result.ok());
      assert.equal((await result.json()).correct, true);
    }
    const nextRequest = { setId: set.id, requestId: randomUUID(), grade: details.grade };
    const next = await context.request.post(`${base}/api/learning/next-practice`, { data: nextRequest });
    assert.ok(next.ok());
    const following = await next.json();
    assert.equal(following.sourceSetId, set.id);
    assert.ok(following.questions.every(q => q.pointId === point));
    const replay = await context.request.post(`${base}/api/learning/next-practice`, { data: nextRequest });
    assert.equal((await replay.json()).id, following.id);
    await page.getByRole('button', { name: '回到网站首页' }).click();
    await page.locator('.liquid-navigation').waitFor();
    assert.deepEqual(errors, []);
    console.log(`专项题单 ${actual}/20，原题 ID、缺题提示、批改、下一组和重试均通过`);
  } finally {
    await browser?.close();
    app.kill();
    await closed;
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
