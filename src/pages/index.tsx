import Link from 'next/link';
import styles from '@/styles/HomePage.module.css';

export default function HomePage() {
  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Welcome to Job Tracker</h1>
      <div className={styles.buttonGroup}>
        <Link href="/jobs" className={styles.button} tabIndex={0}>
          View Jobs
        </Link>
        <Link href="/companies" className={styles.button} tabIndex={0}>
          View Companies
        </Link>
        <Link href="/companies/new" className={styles.button} tabIndex={0}>
          Add New Company
        </Link>
      </div>
    </div>
  );
}
