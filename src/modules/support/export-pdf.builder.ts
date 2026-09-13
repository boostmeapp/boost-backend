import PDFDocument from 'pdfkit';

const INK = '#16232B';
const MUTED = '#5C6B75';
const ACCENT = '#0C4C5C';
const RULE = '#D9E1E6';

export interface ExportData {
  name: string;
  profile: any;
  stats: { following: number; followers: number };
  videos: any[];
  comments: any[];
  likes: any[];
  transactions: any[];
}

function readableDate(value: unknown): string {
  if (!value) return '—';
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * Renders the user's data as a PDF. Every mail client and phone can open a PDF,
 * which an HTML attachment cannot claim.
 */
export function buildExportPdf(data: ExportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: { Title: 'Your Boostra data', Author: 'Boostra' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    const heading = (label: string) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(1.2);
      doc
        .fillColor(ACCENT)
        .font('Helvetica-Bold')
        .fontSize(13)
        .text(label.toUpperCase(), left, doc.y, { characterSpacing: 0.6 });
      doc.moveDown(0.35);
      doc
        .strokeColor(ACCENT)
        .lineWidth(1.5)
        .moveTo(left, doc.y)
        .lineTo(left + width, doc.y)
        .stroke();
      doc.moveDown(0.7);
    };

    const fact = (label: string, value: string) => {
      if (doc.y > doc.page.height - 90) doc.addPage();
      const y = doc.y;
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(10.5)
        .text(label, left, y, { width: width * 0.34 });
      doc
        .fillColor(INK)
        .font('Helvetica')
        .fontSize(10.5)
        .text(value, left + width * 0.34, y, { width: width * 0.66 });
      doc.moveDown(0.55);
    };

    const empty = (message: string) => {
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10.5)
        .text(message, left, doc.y, { width });
      doc.moveDown(0.4);
    };

    // A simple column table that paginates rather than overflowing the page.
    const table = (headers: string[], widths: number[], rows: string[][]) => {
      if (!rows.length) {
        empty('Nothing recorded.');
        return;
      }

      const cols = widths.map((w) => w * width);

      const drawHeader = () => {
        const y = doc.y;
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9);
        let x = left;
        headers.forEach((h, i) => {
          doc.text(h.toUpperCase(), x, y, { width: cols[i] - 8 });
          x += cols[i];
        });
        doc.moveDown(0.35);
        doc
          .strokeColor(RULE)
          .lineWidth(0.75)
          .moveTo(left, doc.y)
          .lineTo(left + width, doc.y)
          .stroke();
        doc.moveDown(0.4);
      };

      drawHeader();

      rows.forEach((row) => {
        // Measure the tallest cell so wrapped text cannot overlap the next row.
        doc.font('Helvetica').fontSize(10);
        const height = Math.max(
          ...row.map((cell, i) =>
            doc.heightOfString(cell, { width: cols[i] - 8 }),
          ),
        );

        if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawHeader();
        }

        const y = doc.y;
        let x = left;
        doc.fillColor(INK).font('Helvetica').fontSize(10);
        row.forEach((cell, i) => {
          doc.text(cell, x, y, { width: cols[i] - 8 });
          x += cols[i];
        });

        doc.y = y + height + 6;
        doc
          .strokeColor(RULE)
          .lineWidth(0.5)
          .moveTo(left, doc.y - 3)
          .lineTo(left + width, doc.y - 3)
          .stroke();
      });
    };

    const p = data.profile || {};

    // Cover
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(26).text('Your Boostra data', left, doc.y);
    doc.moveDown(0.3);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(11)
      .text(`Prepared for ${data.name} on ${readableDate(new Date())}`, { width });
    doc.moveDown(0.5);
    doc
      .fillColor(MUTED)
      .fontSize(10)
      .text(
        'This document contains the personal information Boostra holds for your account.',
        { width },
      );

    heading('Account');
    fact('Name', text([p.firstName, p.lastName].filter(Boolean).join(' ')));
    fact('Username', text(p.username));
    fact('Email', text(p.email));
    fact('Gender', text(p.gender));
    fact('Date of birth', readableDate(p.dob));
    fact('Bio', text(p.bio));
    fact('Joined', readableDate(p.createdAt));

    heading('Activity summary');
    fact('Followers', String(data.stats.followers));
    fact('Following', String(data.stats.following));
    fact('Videos posted', String(data.videos.length));
    fact('Comments written', String(data.comments.length));
    fact('Videos liked', String(data.likes.length));

    heading('Your videos');
    table(
      ['Title', 'Views', 'Likes', 'Posted'],
      [0.46, 0.14, 0.14, 0.26],
      data.videos.map((v) => [
        text(v.title),
        String(v.viewCount ?? 0),
        String(v.likeCount ?? 0),
        readableDate(v.createdAt),
      ]),
    );

    heading('Your comments');
    table(
      ['Comment', 'Written'],
      [0.7, 0.3],
      data.comments.map((c) => [text(c.content), readableDate(c.createdAt)]),
    );

    heading('Transactions');
    table(
      ['Type', 'Amount', 'Status', 'Date'],
      [0.3, 0.2, 0.22, 0.28],
      data.transactions.map((t) => [
        text(t.type),
        text(t.amount),
        text(t.status),
        readableDate(t.createdAt),
      ]),
    );

    doc.moveDown(1.5);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(9)
      .text(
        'If you did not request this export, please change your password and contact support.',
        left,
        doc.y,
        { width },
      );

    doc.end();
  });
}
