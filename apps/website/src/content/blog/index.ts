import { articleCoachAthleteCommunication } from './article-coach-athlete-communication';
import { articleDigitalizingClubs } from './article-digitalizing-clubs';
import { articleOpenathleteOpensourceBenefits } from './article-openathlete-opensource-benefits';
import { articleSyncWorkouts } from './article-sync-workouts';
import { articleTrimp } from './article-trimp';
import { articleYouthTalentDetection } from './article-youth-talent-detection';
import type { BlogPost } from './types';

// Export all blog posts
export const blogPosts: BlogPost[] = [
  articleCoachAthleteCommunication,
  articleDigitalizingClubs,
  articleYouthTalentDetection,
  articleOpenathleteOpensourceBenefits,
  articleSyncWorkouts,
  articleTrimp,
];

// Helper function to get a post by slug
export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find((post) => post.metadata.slug === slug);
}

// Helper function to get all posts sorted by date (newest first)
export function getAllPosts(): BlogPost[] {
  return [...blogPosts].sort(
    (a, b) =>
      new Date(b.metadata.publishedAt).getTime() -
      new Date(a.metadata.publishedAt).getTime(),
  );
}

// Helper function to get posts by tag
export function getPostsByTag(tag: string): BlogPost[] {
  return blogPosts.filter((post) =>
    post.metadata.tags?.some((t) =>
      t.toLowerCase().includes(tag.toLowerCase()),
    ),
  );
}
